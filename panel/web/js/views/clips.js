// Pestaña Clips: interruptor Control, pestañas (decks), master, BPM, capas con sus clips.
// La estructura se arma solo cuando cambia (capas/clips/decks); el resto se parchea para no
// romper un slider que se está arrastrando ni perder el foco.

import { S, emit, isAdmin } from "../store.js";
import { cmd, thumbs } from "../api.js";
import { confirmDialog, toast } from "../ui.js";
import { clamp, h, icon, throttle } from "../util.js";

const PENDING_CLIP_MS = 4000;
const PENDING_DECK_MS = 12000;
const HOLD_MS = 1500;

export function createClipsTab() {
  const admin = isAdmin();
  const el = h("div", { class: "clips" });

  /** clipId → ms en que se tocó (respuesta optimista hasta el próximo state). */
  const pendingClips = new Map();
  /** @type {{index:number, since:number} | null} */
  let pendingDeck = null;
  /** @type {{value:number, since:number} | null} */
  let pendingBpm = null;
  let editingBpm = false;

  let sig = null;
  let refs = null;

  // ------------------------------------------------------------ Interruptor Control (fijo)
  const switchBtn = admin
    ? h(
        "button",
        {
          type: "button",
          role: "switch",
          class: "switch",
          "aria-checked": "false",
          dataset: { key: "control-switch" },
          onclick: () => {
            S.control = !S.control;
            emit("control");
            if (S.control) toast("Control activo: un toque lanza el clip", "info", 2200);
          },
        },
        h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-knob" })),
        h("span", { class: "switch-label" }, "Control"),
      )
    : null;
  const armState = h("span", { class: "arm-state", "aria-live": "polite" });
  const toolbar = admin
    ? h("div", { class: "ctl-bar" }, h("div", { class: "ctl-bar-inner" }, switchBtn, armState))
    : h("div", { class: "ctl-bar is-viewer" }, h("div", { class: "ctl-bar-inner" }, h("span", { class: "chip" }, "Solo lectura")));
  const body = h("div", { class: "clips-body" });
  el.append(toolbar, body);

  function hintControl() {
    toast("Activa «Control» para cambiar la salida", "info", 2200);
    if (!switchBtn) return;
    switchBtn.classList.remove("is-nudge");
    void switchBtn.offsetWidth;
    switchBtn.classList.add("is-nudge");
  }

  const guard = () => {
    if (S.control) return true;
    hintControl();
    return false;
  };

  // ------------------------------------------------------------ Piezas
  /** Slider 0..1 con envío limitado (~150 ms) y valor final al soltar. */
  function slider({ key, label, value, send }) {
    let holdUntil = 0;
    let dragging = false;
    const input = h("input", {
      type: "range",
      min: "0",
      max: "100",
      step: "1",
      value: String(Math.round(value * 100)),
      "aria-label": label,
      class: "range",
      dataset: { key },
    });
    const out = h("output", { class: "range-out mono" }, `${Math.round(value * 100)} %`);
    const throttled = throttle((v) => cmdIfControl(send(v)), 150);
    const paint = () => {
      input.style.setProperty("--val", `${input.value}%`);
      out.textContent = `${input.value} %`;
      input.setAttribute("aria-valuetext", `${input.value} %`);
    };
    input.addEventListener("pointerdown", () => (dragging = true));
    const endDrag = () => (dragging = false);
    input.addEventListener("pointerup", endDrag);
    input.addEventListener("pointercancel", endDrag);
    input.addEventListener("input", () => {
      holdUntil = Date.now() + HOLD_MS;
      paint();
      throttled(Number(input.value) / 100);
    });
    input.addEventListener("change", () => {
      holdUntil = Date.now() + HOLD_MS;
      dragging = false;
      throttled.flush(Number(input.value) / 100);
    });
    const wrap = h("div", { class: "range-wrap", onclick: () => !S.control && hintControl() }, input);
    paint();
    return {
      wrap,
      out,
      input,
      set(v) {
        if (dragging || Date.now() < holdUntil) return;
        const n = String(Math.round(v * 100));
        if (input.value !== n) {
          input.value = n;
          paint();
        }
      },
    };
  }

  function cmdIfControl(command) {
    if (!S.control) return;
    cmd(command);
  }

  function deckRow(comp) {
    const chips = new Map();
    const row = h("div", { class: "deck-row", role: admin ? "group" : null, "aria-label": "Pestañas de Resolume" });
    for (const d of comp.decks) {
      const label = h("span", { class: "deck-name" }, d.name || `Pestaña ${d.index}`);
      const note = h("span", { class: "deck-note" });
      const chip = admin
        ? h(
            "button",
            {
              type: "button",
              class: "deck-chip",
              dataset: { key: `deck-${d.index}` },
              onclick: () => selectDeck(d),
            },
            label,
            note,
          )
        : h("span", { class: "deck-chip" }, label);
      chips.set(d.index, { chip, note });
      row.append(chip);
    }
    return { row, chips };
  }

  async function selectDeck(d) {
    if (!guard()) return;
    if (d.selected && !pendingDeck) return;
    pendingDeck = { index: d.index, since: Date.now() };
    patch();
    const r = await cmd({ action: "selectDeck", deckIndex: d.index });
    if (!r.ok) {
      pendingDeck = null;
      patch();
    }
  }

  function bpmBox(comp) {
    const box = h("div", { class: "bpm" });
    const valueBtn = h(
      "button",
      {
        type: "button",
        class: "bpm-value mono",
        "aria-label": "BPM, tocar para escribir",
        dataset: { key: "bpm-value" },
        onclick: () => {
          if (!guard()) return;
          startEdit();
        },
      },
      "",
    );
    const valueText = admin ? valueBtn : h("span", { class: "bpm-value mono" }, "");
    const step = (delta) => {
      if (!guard()) return;
      const base = pendingBpm ? pendingBpm.value : S.state?.composition?.bpm ?? 120;
      sendBpm(Math.round((base + delta) * 100) / 100);
    };
    const minus = h(
      "button",
      { type: "button", class: "btn btn-icon", "aria-label": "Bajar BPM", dataset: { key: "bpm-minus" }, onclick: () => step(-1) },
      icon("minus"),
    );
    const plus = h(
      "button",
      { type: "button", class: "btn btn-icon", "aria-label": "Subir BPM", dataset: { key: "bpm-plus" }, onclick: () => step(1) },
      icon("plus"),
    );
    const line = h("div", { class: "bpm-line" }, admin ? minus : null, valueText, admin ? plus : null);
    box.append(h("span", { class: "legend" }, "BPM"), line);

    function startEdit() {
      editingBpm = true;
      const input = h("input", {
        type: "number",
        inputmode: "decimal",
        min: "20",
        max: "500",
        step: "0.01",
        class: "bpm-input mono",
        "aria-label": "Nuevo BPM",
        value: String(pendingBpm?.value ?? S.state?.composition?.bpm ?? 120),
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        editingBpm = false;
        line.replaceChildren(minus, valueBtn, plus);
        patch();
        valueBtn.focus();
      };
      const form = h(
        "form",
        {
          class: "bpm-form",
          onsubmit: (e) => {
            e.preventDefault();
            if (!guard()) return finish();
            const v = Number(String(input.value).replace(",", "."));
            if (!Number.isFinite(v) || v < 20 || v > 500) {
              toast("BPM entre 20 y 500", "error");
              input.focus();
              return;
            }
            sendBpm(Math.round(v * 100) / 100);
            finish();
          },
        },
        input,
        h("button", { type: "submit", class: "btn btn-primary" }, "OK"),
        h("button", { type: "button", class: "btn", onclick: finish }, "Cancelar"),
      );
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") finish();
      });
      line.replaceChildren(form);
      input.focus();
      input.select();
    }

    return { box, set: (txt) => (valueBtn.textContent = valueText.textContent = txt) };
  }

  async function sendBpm(v) {
    v = clamp(v, 20, 500);
    pendingBpm = { value: v, since: Date.now() };
    patch();
    const r = await cmd({ action: "setBpm", bpm: v });
    if (!r.ok) {
      pendingBpm = null;
      patch();
    }
  }

  function clipTile(clip, layer) {
    const thumb = h(
      "div",
      { class: "thumb" },
      h("img", { alt: "", decoding: "async" }),
      h("span", { class: "thumb-fallback mono", "aria-hidden": "true" }, `C${clip.column}`),
    );
    const tally = h("span", { class: "clip-tally", "aria-hidden": "true" });
    const sr = h("span", { class: "sr-only" });
    const tile = h(
      admin ? "button" : "div",
      {
        type: admin ? "button" : null,
        class: "clip",
        dataset: { key: `clip-${clip.id}` },
        onclick: admin ? () => trigger(clip) : null,
      },
      thumb,
      tally,
      h("span", { class: "clip-name" }, clip.name || `Clip ${clip.column}`),
      h("span", { class: "clip-col mono", "aria-hidden": "true" }, `C${clip.column}`),
      sr,
    );
    return { tile, thumb, tally, sr, clip, layer };
  }

  async function trigger(clip) {
    if (!guard()) return;
    const prev = pendingClips.get(clip.id);
    if (prev && Date.now() - prev < 600) return; // doble toque
    pendingClips.set(clip.id, Date.now());
    patch();
    const r = await cmd({ action: "triggerClip", clipId: clip.id });
    if (!r.ok) {
      pendingClips.delete(clip.id);
      patch();
    }
  }

  // ------------------------------------------------------------ Armado
  function signature(comp) {
    if (!comp) return "none";
    return JSON.stringify([
      comp.decks.map((d) => [d.index, d.name]),
      comp.columns.map((c) => [c.index, c.name]),
      comp.layers.map((l) => [l.index, l.id, l.name, l.clips.filter((c) => c.state !== "empty").map((c) => [c.id, c.name, c.column])]),
    ]);
  }

  function build(comp) {
    refs = { tiles: [], layers: [], decks: null, master: null, bpm: null };
    if (!comp) {
      body.replaceChildren(
        h("p", { class: "empty" }, S.state ? "Resolume no responde: no hay clips para mostrar." : "Cargando composición…"),
      );
      return;
    }
    const parts = [];

    refs.decks = deckRow(comp);
    parts.push(h("section", { class: "deck-section", "aria-label": "Pestaña" }, h("h2", { class: "legend" }, "Pestaña"), refs.decks.row));

    // Master + BPM
    refs.bpm = bpmBox(comp);
    let masterPart;
    if (admin) {
      refs.master = slider({
        key: "master",
        label: "Master",
        value: comp.master,
        send: (v) => ({ action: "setMaster", value: v }),
      });
      masterPart = h(
        "div",
        { class: "master" },
        h("div", { class: "row-between" }, h("span", { class: "legend" }, "Master"), refs.master.out),
        refs.master.wrap,
      );
    } else {
      refs.masterText = h("span", { class: "stat-value mono" });
      masterPart = h("div", { class: "master" }, h("span", { class: "legend" }, "Master"), refs.masterText);
    }
    parts.push(h("section", { class: "mixer card", "aria-label": "Master y BPM" }, masterPart, refs.bpm.box));

    // Capas (la más alta arriba, como en Arena)
    const toAttach = [];
    for (const layer of [...comp.layers].sort((a, b) => b.index - a.index)) {
      const clips = layer.clips.filter((c) => c.state !== "empty").sort((a, b) => a.column - b.column);
      const onair = h("span", { class: "layer-onair" });
      const badges = h("span", { class: "layer-badges" });
      const grid = h("div", { class: "clip-grid" });
      for (const c of clips) {
        const t = clipTile(c, layer);
        refs.tiles.push(t);
        grid.append(t.tile);
        toAttach.push(t);
      }
      const lref = { index: layer.index, onair, badges, slider: null, opText: null };
      let ctl;
      if (admin) {
        lref.slider = slider({
          key: `op-${layer.index}`,
          label: `Opacidad de ${layer.name || `capa ${layer.index}`}`,
          value: layer.opacity,
          send: (v) => ({ action: "setLayerOpacity", layer: layer.index, value: v }),
        });
        ctl = h(
          "div",
          { class: "layer-ctl" },
          h("span", { class: "legend" }, "Opac."),
          lref.slider.wrap,
          lref.slider.out,
          h(
            "button",
            {
              type: "button",
              class: "btn btn-sm btn-danger-outline",
              dataset: { key: `clear-${layer.index}` },
              "aria-label": `Apagar ${layer.name || `capa ${layer.index}`}`,
              onclick: () => guard() && cmd({ action: "clearLayer", layer: layer.index }),
            },
            icon("power"),
            h("span", null, "Apagar"),
          ),
        );
      } else {
        lref.opText = h("span", { class: "mono muted" });
        ctl = h("div", { class: "layer-ctl" }, h("span", { class: "legend" }, "Opacidad"), lref.opText);
      }
      refs.layers.push(lref);
      parts.push(
        h(
          "section",
          { class: "layer", "aria-label": layer.name || `Capa ${layer.index}` },
          h(
            "header",
            { class: "layer-head" },
            h("h3", { class: "layer-name" }, h("span", { class: "layer-num mono" }, `L${layer.index}`), layer.name || `Capa ${layer.index}`),
            badges,
            onair,
          ),
          ctl,
          clips.length ? grid : h("p", { class: "muted small" }, "Capa sin clips cargados."),
        ),
      );
    }

    if (admin) {
      if (comp.columns.length) {
        parts.push(
          h(
            "details",
            { class: "columns card" },
            h("summary", null, "Lanzar columna completa"),
            h(
              "div",
              { class: "column-grid" },
              comp.columns.map((c) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn",
                    dataset: { key: `col-${c.index}` },
                    onclick: () => guard() && cmd({ action: "triggerColumn", column: c.index }),
                  },
                  c.name || `Columna ${c.index}`,
                ),
              ),
            ),
          ),
        );
      }
      parts.push(
        h(
          "div",
          { class: "clear-all" },
          h(
            "button",
            {
              type: "button",
              class: "btn btn-danger btn-block",
              dataset: { key: "clear-all" },
              onclick: async () => {
                if (!guard()) return;
                const ok = await confirmDialog({
                  title: "¿Apagar todo?",
                  body: "Se desconectan todos los clips de todas las capas. La salida queda en negro.",
                  ok: "Apagar todo",
                  danger: true,
                });
                if (ok) cmd({ action: "clearAll" });
              },
            },
            icon("power"),
            h("span", null, "Apagar todo"),
          ),
        ),
      );
    }

    // Conservar foco al reconstruir.
    const active = document.activeElement;
    const key = active && body.contains(active) ? active.dataset.key : null;
    body.replaceChildren(...parts);
    if (key) body.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    for (const t of toAttach) thumbs.attach(t.thumb, t.clip.id, t.clip.name);
  }

  // ------------------------------------------------------------ Parches
  function patch() {
    applyControl();
    const comp = S.state?.composition;
    if (!comp || !refs) return;

    const clipById = new Map();
    for (const l of comp.layers) for (const c of l.clips) clipById.set(c.id, c);

    for (const t of refs.tiles) {
      const c = clipById.get(t.clip.id) || t.clip;
      if (c.state === "connected") pendingClips.delete(c.id);
      const pending = pendingClips.has(c.id);
      t.tile.classList.toggle("is-on", c.state === "connected");
      t.tile.classList.toggle("is-preview", c.state === "previewing");
      t.tile.classList.toggle("is-pending", pending);
      const label = pending ? "LANZANDO" : c.state === "connected" ? "AL AIRE" : c.state === "previewing" ? "PREVIO" : "";
      t.tally.textContent = label;
      t.tally.hidden = !label;
      t.sr.textContent = label ? `, ${label.toLowerCase()}` : "";
      if (admin) t.tile.setAttribute("aria-label", `Lanzar ${c.name || `clip ${c.column}`}, columna ${c.column}${label ? `, ${label.toLowerCase()}` : ""}`);
    }

    for (const lr of refs.layers) {
      const layer = comp.layers.find((l) => l.index === lr.index);
      if (!layer) continue;
      const on = layer.clips.find((c) => c.state === "connected");
      lr.onair.replaceChildren(
        ...[
          on ? h("span", { class: "tally tally-air" }, "AL AIRE") : h("span", { class: "tally tally-idle" }, "LIBRE"),
          on ? h("span", { class: "layer-onair-name" }, on.name) : null,
        ].filter(Boolean),
      );
      lr.badges.replaceChildren(
        ...[
          layer.bypassed ? h("span", { class: "chip chip-warn" }, "Bypass") : null,
          layer.solo ? h("span", { class: "chip chip-warn" }, "Solo") : null,
        ].filter(Boolean),
      );
      if (lr.slider) lr.slider.set(layer.opacity);
      if (lr.opText) lr.opText.textContent = `${Math.round(layer.opacity * 100)} %`;
    }

    if (refs.master) refs.master.set(comp.master);
    if (refs.masterText) refs.masterText.textContent = `${Math.round(comp.master * 100)} %`;

    if (pendingBpm && Math.abs(comp.bpm - pendingBpm.value) < 0.01) pendingBpm = null;
    if (refs.bpm && !editingBpm) {
      const v = pendingBpm ? pendingBpm.value : comp.bpm;
      refs.bpm.set(v.toFixed(2).replace(/\.?0+$/, ""));
      refs.bpm.box.classList.toggle("is-pending", !!pendingBpm);
    }

    const selected = comp.decks.find((d) => d.selected);
    if (pendingDeck && selected && selected.index === pendingDeck.index) pendingDeck = null;
    if (refs.decks) {
      for (const d of comp.decks) {
        const r = refs.decks.chips.get(d.index);
        if (!r) continue;
        const isPending = pendingDeck?.index === d.index;
        r.chip.classList.toggle("is-selected", d.selected);
        r.chip.classList.toggle("is-pending", isPending);
        if (admin) r.chip.setAttribute("aria-pressed", String(d.selected));
        r.note.textContent = isPending ? "cambiando…" : d.selected ? "abierta" : "";
      }
    }
  }

  function applyControl() {
    if (!admin) return;
    switchBtn.setAttribute("aria-checked", String(S.control));
    el.classList.toggle("is-armed", S.control);
    el.classList.toggle("is-locked", !S.control);
    armState.textContent = S.control ? "Activo: un toque lanza" : "Apagado: tocar no lanza nada";
    for (const input of el.querySelectorAll("input.range")) input.disabled = !S.control;
    for (const b of body.querySelectorAll("button")) {
      if (S.control) b.removeAttribute("aria-disabled");
      else b.setAttribute("aria-disabled", "true");
    }
  }

  function update() {
    const comp = S.state?.composition || null;
    const s = signature(comp);
    if (s !== sig) {
      sig = s;
      build(comp);
    }
    patch();
  }

  /** Vence respuestas optimistas que nunca se confirmaron. */
  function tick() {
    const now = Date.now();
    let dirty = false;
    for (const [id, at] of pendingClips) {
      if (now - at > PENDING_CLIP_MS) {
        pendingClips.delete(id);
        dirty = true;
      }
    }
    if (pendingDeck && now - pendingDeck.since > PENDING_DECK_MS) {
      pendingDeck = null;
      toast("La pestaña no cambió todavía", "error");
      dirty = true;
    }
    if (pendingBpm && now - pendingBpm.since > 3000) {
      pendingBpm = null;
      dirty = true;
    }
    if (dirty) patch();
  }

  update();
  return { el, update, tick, applyControl: patch };
}
