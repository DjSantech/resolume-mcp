// Miniaturas de clips: se piden al verse en pantalla, como mucho 3 a la vez, y se guardan por clip.

const MAX_IN_FLIGHT = 3;
const RETRY_FAILED_MS = 60000;

export class Thumbs {
  /** @param {(clipId: number) => Promise<{ok:boolean, data?:any}>} request */
  constructor(request) {
    this.request = request;
    /** key → data URL */
    this.cache = new Map();
    /** key → ms del fallo */
    this.failed = new Map();
    /** key → Set de contenedores esperando */
    this.waiting = new Map();
    /** keys en cola, en orden */
    this.queue = [];
    this.inFlight = new Set();
    this.scope = "";
    this.observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: "200px 0px" })
        : null;
  }

  /** Cambia de evento: las miniaturas de otro evento no se mezclan. */
  setScope(eventId) {
    this.scope = eventId || "";
    this.queue = [];
    this.waiting.clear();
    this.observer?.disconnect();
  }

  keyFor(clipId, name) {
    // El nombre entra en la clave: si cargan otro archivo en el mismo lugar, se pide de nuevo.
    return `${this.scope}|${clipId}|${name}`;
  }

  /**
   * Asocia un contenedor .thumb (con un <img> dentro) a un clip.
   * @param {HTMLElement} box
   */
  attach(box, clipId, name) {
    const key = this.keyFor(clipId, name);
    box.dataset.thumbKey = key;
    box.dataset.clipId = String(clipId);
    const cached = this.cache.get(key);
    if (cached) return this.paint(box, cached);
    const failedAt = this.failed.get(key);
    if (failedAt && Date.now() - failedAt < RETRY_FAILED_MS) return;
    if (!this.waiting.has(key)) this.waiting.set(key, new Set());
    this.waiting.get(key).add(box);
    if (this.observer) this.observer.observe(box);
    else this.enqueue(key);
  }

  onIntersect(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.observer.unobserve(e.target);
      this.enqueue(e.target.dataset.thumbKey);
    }
  }

  enqueue(key) {
    if (!key || this.cache.has(key) || this.inFlight.has(key) || this.queue.includes(key)) return;
    this.queue.push(key);
    this.pump();
  }

  pump() {
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length) {
      const key = this.queue.shift();
      const boxes = this.waiting.get(key);
      // Si ya nadie lo muestra (cambió la pestaña), no se pide.
      if (!boxes || ![...boxes].some((b) => b.isConnected)) {
        this.waiting.delete(key);
        continue;
      }
      const clipId = Number(key.split("|")[1]);
      const scope = this.scope;
      this.inFlight.add(key);
      this.request(clipId)
        .then((r) => {
          if (r.ok && r.data && typeof r.data.data === "string") {
            const url = `data:${r.data.mime || "image/png"};base64,${r.data.data}`;
            this.cache.set(key, url);
            this.failed.delete(key);
            for (const b of this.waiting.get(key) || []) if (b.isConnected) this.paint(b, url);
          } else if (r.ok || !/conexión/i.test(r.error || "")) {
            this.failed.set(key, Date.now());
          }
        })
        .finally(() => {
          this.inFlight.delete(key);
          if (scope === this.scope) this.waiting.delete(key);
          this.pump();
        });
    }
  }

  paint(box, url) {
    const img = box.querySelector("img");
    if (!img) return;
    img.onerror = () => box.classList.remove("has-img");
    img.src = url;
    box.classList.add("has-img");
  }
}
