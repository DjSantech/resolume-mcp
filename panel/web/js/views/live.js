// Pestaña En vivo: captura de la salida, qué suena por capa, BPM, master y automatización.

import { S } from "../store.js";
import { cmd } from "../api.js";
import { runnerCard } from "../runner.js";
import { ago, h, pct, replaceKeepFocus } from "../util.js";

export function createLiveTab() {
  const img = h("img", { class: "snap-img", alt: "Captura de la salida de Resolume", decoding: "async" });
  const age = h("span", { class: "snap-age mono" }, "");
  const placeholder = h("div", { class: "snap-empty" }, "Toca Refrescar para ver la pantalla");
  const frame = h("div", { class: "snap-frame" }, placeholder, img, age);
  // La captura se pide a mano para no gastar datos con una imagen cada pocos segundos.
  const refreshBtn = h("button", { type: "button", class: "btn btn-block snap-refresh" }, "Refrescar");
  refreshBtn.addEventListener("click", () => refresh());
  const info = h("div", { class: "live-info" });
  const el = h("div", { class: "live" }, h("figure", { class: "snap" }, frame), refreshBtn, info);

  let loading = false;
  async function refresh() {
    if (loading || !S.eventId) return;
    loading = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Cargando…";
    const r = await cmd({ action: "getSnapshot" });
    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refrescar";
    if (!r.ok || typeof r.data?.data !== "string") return;
    S.snapshot = { url: `data:${r.data.mime || "image/jpeg"};base64,${r.data.data}`, at: r.data.at };
    S.snapClock.observe(r.data.at);
    updateSnapshot();
  }

  function updateSnapshot() {
    const snap = S.snapshot;
    if (snap) {
      if (img.getAttribute("src") !== snap.url) img.src = snap.url;
      frame.classList.add("has-img");
    } else {
      img.removeAttribute("src");
      frame.classList.remove("has-img");
    }
    tick();
  }

  function tick() {
    const snap = S.snapshot;
    if (!snap) {
      age.textContent = "";
      age.hidden = true;
      return;
    }
    const ms = Date.now() - S.snapClock.toLocal(snap.at);
    age.hidden = false;
    age.textContent = ago(ms);
    age.dataset.age = ms > 30000 ? "old" : ms > 10000 ? "late" : "fresh";
  }

  function update() {
    const st = S.state;
    const comp = st?.composition;
    if (comp?.width && comp?.height) frame.style.setProperty("aspect-ratio", `${comp.width} / ${comp.height}`);

    const parts = [];
    if (st?.runner) parts.push(runnerCard(st.runner));

    // Qué suena en cada capa (de arriba hacia abajo, como en Arena).
    const layers = comp ? [...comp.layers].sort((a, b) => b.index - a.index) : [];
    const byLayer = new Map((st?.nowPlaying || []).map((np) => [np.layer, np]));
    const rows = layers.length
      ? layers.map((l) => {
          const np = byLayer.get(l.index);
          return h(
            "li",
            { class: `onair-row ${np ? "is-on" : ""}` },
            h("span", { class: "onair-layer" }, l.name || `Capa ${l.index}`),
            h("span", { class: "onair-lamp", "aria-hidden": "true" }),
            h("span", { class: "onair-clip" }, np ? np.name : "—", np ? h("span", { class: "sr-only" }, " (al aire)") : null),
            h("span", { class: "onair-meta mono muted" }, np ? `C${np.column}` : "", l.opacity < 1 ? ` · ${pct(l.opacity)}` : ""),
          );
        })
      : (st?.nowPlaying || []).map((np) =>
          h(
            "li",
            { class: "onair-row is-on" },
            h("span", { class: "onair-layer" }, np.layerName || `Capa ${np.layer}`),
            h("span", { class: "onair-lamp", "aria-hidden": "true" }),
            h("span", { class: "onair-clip" }, np.name),
            h("span", { class: "onair-meta mono muted" }, `C${np.column}`),
          ),
        );

    parts.push(
      h(
        "section",
        { class: "card", "aria-label": "Qué suena" },
        h("h2", { class: "legend" }, "Al aire por capa"),
        rows.length ? h("ul", { class: "onair-list" }, rows) : h("p", { class: "muted" }, st ? "Sin datos de capas." : "Cargando…"),
      ),
    );

    if (comp) {
      const deck = comp.decks.find((d) => d.selected);
      parts.push(
        h(
          "section",
          { class: "stats card", "aria-label": "Composición" },
          stat("BPM", comp.bpm.toFixed(2).replace(/\.?0+$/, "")),
          stat("Master", pct(comp.master)),
          stat("Pestaña", deck ? deck.name : "—", false),
          stat("Salida", comp.width && comp.height ? `${comp.width}×${comp.height}` : "—"),
        ),
        h(
          "p",
          { class: "muted small comp-line" },
          comp.name,
          st.resolume ? ` · ${st.resolume.product} ${st.resolume.version}` : "",
        ),
      );
    }
    replaceKeepFocus(info, parts);
  }

  function stat(label, value, mono = true) {
    return h("div", { class: "stat" }, h("span", { class: "legend" }, label), h("span", { class: `stat-value ${mono ? "mono" : ""}` }, value));
  }

  updateSnapshot();
  update();
  // Una captura al abrir la pestaña, para no empezar en blanco.
  if (!S.snapshot) setTimeout(() => refresh(), 300);
  return { el, update, updateSnapshot, tick };
}
