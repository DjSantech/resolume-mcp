// Utilidades sin dependencias: DOM, íconos, almacenamiento, ids, formato y tiempo.

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate", "textContent"]);

/** Crea un elemento. props: class, dataset, style (objeto de propiedades CSS), on<evento>, atributos. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Reemplaza los hijos de un contenedor conservando el foco por data-key. */
export function replaceKeepFocus(container, ...children) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.key : null;
  container.replaceChildren();
  append(container, children);
  if (key) {
    const next = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (next) next.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- Íconos (SVG propios)

const ICONS = {
  back: "M15 5l-7 7 7 7",
  logout: "M10 5H5v14h5M14 8l4 4-4 4M18 12H9",
  power: "M12 3v8M7.05 6.05a8 8 0 1 0 9.9 0",
  skip: "M6 6l8 6-8 6V6zM17 6v12",
  stop: "M7 7h10v10H7z",
  play: "M8 5l11 7-11 7V5z",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  close: "M6 6l12 12M18 6L6 18",
  live: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  loop: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4",
  list: "M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1",
  check: "M5 12l5 5 9-10",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  screen: "M3 6h18v12H3zM3 12h18M9 6v12M15 6v12",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  user: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21c1-4 4.5-6 8-6s7 2 8 6",
  pc: "M3 5h18v11H3zM8 20h8M12 16v4",
};

const SVG = "http://www.w3.org/2000/svg";

export function icon(name, cls = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", ICONS[name] || "");
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- Almacenamiento seguro

export const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* modo privado o almacenamiento bloqueado */
    }
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* idem */
    }
  },
};

// ---------------------------------------------------------------- Ids

/** UUID v4. crypto.randomUUID solo existe en contextos seguros (https); en http del hotspot se usa getRandomValues. */
export function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* sigue abajo */
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- Formato

const pad = (n) => String(n).padStart(2, "0");

export function clockTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dateTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clockTime(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${clockTime(ms)}`;
}

/** "hace 4 s", "hace 3 min", "hace 2 h". */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

/** Segundos a "m:ss" (o "h:mm:ss"). */
export function mmss(totalS) {
  const s = Math.max(0, Math.round(totalS));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** Segundos a texto corto en minutos: "1,5 min", "45 s". */
export function minutesText(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round((sec / 60) * 10) / 10;
  return `${String(m).replace(".", ",")} min`;
}

export const pct = (v) => `${Math.round((Number(v) || 0) * 100)} %`;

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- Tiempo

/** Llamadas como mucho cada `ms` (primera inmediata, última garantizada). flush() envía ya lo pendiente. */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  const run = () => {
    timer = null;
    last = Date.now();
    const args = pending;
    pending = null;
    fn(...args);
  };
  const call = (...args) => {
    pending = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0 && !timer) run();
    else if (!timer) timer = setTimeout(run, wait);
  };
  call.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = args.length ? args : pending;
    if (pending) run();
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return call;
}

/**
 * Estima el desfase entre el reloj del PC del evento y el de este equipo.
 * Toma el mínimo de (llegada local − marca remota): latencia mínima + desfase.
 */
export class ClockSync {
  constructor() {
    this.offset = null;
  }
  observe(remoteMs) {
    if (typeof remoteMs !== "number" || !Number.isFinite(remoteMs)) return;
    const d = Date.now() - remoteMs;
    if (this.offset === null || d < this.offset) this.offset = d;
  }
  toLocal(remoteMs) {
    return remoteMs + (this.offset ?? 0);
  }
  reset() {
    this.offset = null;
  }
}
