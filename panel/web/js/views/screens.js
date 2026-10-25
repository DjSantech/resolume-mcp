// Pestaña Pantallas: diseños de pantalla LED armados con gabinetes → Salida Avanzada de Resolume.
// Escenario = cómo se ve afuera (posiciones reales). Salida = lo que recibe el procesador LED (1:1).
// La composición de Resolume recibe el escenario escalado de forma uniforme y centrado (lo hace el puente).

import { S, isAdmin } from "../store.js";
import { cmd } from "../api.js";
import { confirmDialog, toast } from "../ui.js";
import { h, icon, replaceKeepFocus, uuid } from "../util.js";

/** Como replaceChildren, pero sin los null/false (replaceChildren los mostraría como texto). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

/** Gabinetes comunes. w/h en píxeles por gabinete. */
const CABINETS = [
  { id: "p26", label: "P2.6 500×500 mm", w: 192, h: 192 },
  { id: "p29", label: "P2.9 500×500 mm", w: 168, h: 168 },
  { id: "p39", label: "P3.9 500×500 mm", w: 128, h: 128 },
  { id: "p39t", label: "P3.9 500×1000 mm", w: 128, h: 256 },
  { id: "p48", label: "P4.8 500×500 mm", w: 104, h: 104 },
  { id: "custom", label: "Personalizado", w: 0, h: 0 },
];
const DEFAULT_CAB = "p39";
const MAX_PX = 16384;
const MAX_CAB = 200;
const OUT_SNAP = 8;
const MAGNET = 12;
/** Colores apagados para distinguir piezas (pantalla y plantilla PNG). */
const PALETTE = ["#3f6489", "#8a4f63", "#4f7a4c", "#8a6d3f", "#5f5390", "#3f7d79", "#8f5a3c", "#6b7590", "#7a7a3f", "#7a4f8a"];
const colorOf = (i) => PALETTE[i % PALETTE.length];

// ------------------------------------------------------------ Geometría

/** Medidas de cada pieza. g: { cabW, cabH, pieces } */
const pieceW = (g, p) => p.cols * g.cabW;
const pieceH = (g, p) => p.rows * g.cabH;

function stageRects(g) {
  return g.pieces.map((p, i) => ({ p, i, x: p.x, y: p.y, w: pieceW(g, p), h: pieceH(g, p) }));
}

function outRects(g) {
  return g.pieces.map((p, i) => ({ p, i, x: p.outX, y: p.outY, w: pieceW(g, p), h: pieceH(g, p) }));
}

function bbox(rects) {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Escenario dentro de la composición: escala uniforme, centrado (igual que el puente). */
function compFit(g) {
  const rs = stageRects(g);
  const b = bbox(rs);
  const scale = b.w && b.h ? Math.min(g.compW / b.w, g.compH / b.h) : 1;
  const ox = (g.compW - b.w * scale) / 2;
  const oy = (g.compH - b.h * scale) / 2;
  return {
    b,
    scale,
    exact: b.w === g.compW && b.h === g.compH,
    rects: rs.map((r) => ({ ...r, x: ox + (r.x - b.x) * scale, y: oy + (r.y - b.y) * scale, w: r.w * scale, h: r.h * scale })),
  };
}

/** Problemas de la salida y del escenario. */
function problems(g) {
  const list = [];
  const outs = outRects(g);
  for (let i = 0; i < outs.length; i++)
    for (let j = i + 1; j < outs.length; j++)
      if (overlaps(outs[i], outs[j])) list.push({ kind: "bad", ids: [outs[i].p.id, outs[j].p.id], text: `«${nameOf(outs[i])}» y «${nameOf(outs[j])}» se pisan en la salida.` });
  for (const r of outs)
    if (r.x < 0 || r.y < 0 || r.x + r.w > g.outW || r.y + r.h > g.outH)
      list.push({
        kind: "bad",
        ids: [r.p.id],
        text: `«${nameOf(r)}» se sale de la salida: llega hasta ${r.x + r.w}×${r.y + r.h} y la salida mide ${g.outW}×${g.outH}.`,
      });
  const st = stageRects(g);
  for (let i = 0; i < st.length; i++)
    for (let j = i + 1; j < st.length; j++)
      if (overlaps(st[i], st[j])) list.push({ kind: "warn", ids: [], text: `«${nameOf(st[i])}» y «${nameOf(st[j])}» se superponen en el escenario.` });
  return list;
}

const nameOf = (r) => r.p.name.trim() || `Pieza ${r.i + 1}`;

/** Acomodo por estantes: de izquierda a derecha, filas nuevas al no caber; las más altas primero. */
function autoPack(g) {
  const items = g.pieces.map((p) => ({ p, w: pieceW(g, p), h: pieceH(g, p) })).sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > g.outW) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    it.p.outX = x;
    it.p.outY = y;
    x += it.w;
    rowH = Math.max(rowH, it.h);
  }
}

/** 1234.5 → "1234,5"; enteros sin decimales. */
const num = (v) => String(Math.round(v * 10) / 10).replace(".", ",");
const rectText = (r) => `${num(r.x)}, ${num(r.y)} · ${num(r.w)}×${num(r.h)}`;
const per = (v) => `${(v * 100).toFixed(4)}%`;
const scaleText = (s) => `${num(s * 100)} %`;

/** Layout guardado → borrador editable (mismos campos que usa la geometría). */
function toDraft(l) {
  const preset = CABINETS.find((c) => c.w === l.cabinetW && c.h === l.cabinetH && c.label === l.cabinetLabel);
  return {
    isNew: false,
    id: l.id,
    name: l.name,
    cab: preset ? preset.id : "custom",
    cabLabel: l.cabinetLabel,
    cabW: l.cabinetW,
    cabH: l.cabinetH,
    pieces: l.pieces.map((p) => ({ ...p })),
    compW: l.composition.width,
    compH: l.composition.height,
    outW: l.output.width,
    outH: l.output.height,
    outTouched: true,
    view: "stage",
    sel: l.pieces[0]?.id ?? null,
  };
}

function fileName(name) {
  const base = String(name || "pantalla")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `plantilla-${base || "pantalla"}.png`;
}

/** Dibuja la plantilla del tamaño de la composición y la descarga. g: borrador o toDraft(layout). */
function downloadTemplate(g, name) {
  const W = Math.round(g.compW);
  const H = Math.round(g.compH);
  if (!g.pieces.length) return toast("El diseño no tiene piezas", "error");
  if (!(W > 0 && H > 0) || W * H > 100e6) return toast("La composición es demasiado grande para la plantilla", "error");
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return toast("Este navegador no puede dibujar la plantilla", "error");
  c.fillStyle = "#000";
  c.fillRect(0, 0, W, H);
  const fit = compFit(g);
  const s = fit.scale;
  for (const r of fit.rects) {
    const col = colorOf(r.i);
    c.fillStyle = col;
    c.fillRect(r.x, r.y, r.w, r.h);
    // Rejilla de gabinetes
    c.strokeStyle = "rgba(255,255,255,0.28)";
    c.lineWidth = Math.max(1, s);
    c.beginPath();
    for (let k = 1; k < r.p.cols; k++) {
      const x = Math.round(r.x + k * g.cabW * s) + 0.5;
      c.moveTo(x, r.y);
      c.lineTo(x, r.y + r.h);
    }
    for (let k = 1; k < r.p.rows; k++) {
      const y = Math.round(r.y + k * g.cabH * s) + 0.5;
      c.moveTo(r.x, y);
      c.lineTo(r.x + r.w, y);
    }
    c.stroke();
    c.strokeStyle = "rgba(255,255,255,0.75)";
    c.lineWidth = Math.max(2, 2 * s);
    c.strokeRect(r.x + c.lineWidth / 2, r.y + c.lineWidth / 2, r.w - c.lineWidth, r.h - c.lineWidth);
    // Texto centrado; en piezas angostas y altas, girado.
    const rotate = r.h > r.w * 1.6;
    const bw = (rotate ? r.h : r.w) * 0.88;
    const bh = (rotate ? r.w : r.h) * 0.8;
    const line1 = nameOf(r);
    const line2 = `${pieceW(g, r.p)}×${pieceH(g, r.p)} px · ${r.p.cols}×${r.p.rows} gab.`;
    const fitFont = (text, weight, start) => {
      let size = Math.max(6, Math.floor(start));
      c.font = `${weight} ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
      while (size > 6 && c.measureText(text).width > bw) {
        size -= 1;
        c.font = `${weight} ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
      }
      return size;
    };
    const f1 = fitFont(line1, 700, Math.min(bh * 0.34, 96));
    const f2 = fitFont(line2, 400, Math.min(f1 * 0.62, bh * 0.22));
    c.save();
    c.translate(r.x + r.w / 2, r.y + r.h / 2);
    if (rotate) c.rotate(-Math.PI / 2);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "#ffffff";
    const gap = (f1 + f2) * 0.18;
    c.font = `700 ${f1}px system-ui, "Segoe UI", Arial, sans-serif`;
    c.fillText(line1, 0, -(f2 + gap) / 2);
    c.fillStyle = "rgba(255,255,255,0.8)";
    c.font = `400 ${f2}px system-ui, "Segoe UI", Arial, sans-serif`;
    c.fillText(line2, 0, (f1 + gap) / 2);
    c.restore();
  }
  cv.toBlob((blob) => {
    if (!blob) return toast("No se pudo crear la plantilla", "error");
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: fileName(name), hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast(`Plantilla ${W}×${H} descargada`, "ok");
  }, "image/png");
}

// ------------------------------------------------------------ Pestaña

export function createScreensTab() {
  const admin = isAdmin();
  const el = h("div", { class: "screens" });
  /** Borrador en edición (null = lista). */
  let draft = null;
  let editor = null;
  /** Último resultado de readAdvancedOutput. */
  let ao = null;
  let aoBusy = false;
  let aoError = "";
  let dlg = null;

  const layouts = () => [...(S.state?.screens || [])].sort((a, b) => a.name.localeCompare(b.name, "es"));

  // ------------------------------------------------------------ Lista
  function renderList() {
    const st = S.state;
    const parts = [];
    const supported = !!st && Array.isArray(st.screens);
    parts.push(
      h(
        "div",
        { class: "section-head" },
        h("h2", { class: "section-title" }, "Pantallas"),
        admin && supported
          ? h("button", { type: "button", class: "btn btn-primary", dataset: { key: "scr-new" }, onclick: () => openEditor(null) }, icon("plus"), h("span", null, "Nueva"))
          : null,
      ),
    );
    if (!st) parts.push(h("p", { class: "empty" }, "Cargando…"));
    else if (!supported) parts.push(h("div", { class: "note" }, "Actualiza el puente para usar Pantallas."));
    else {
      const list = layouts();
      if (!list.length)
        parts.push(
          h(
            "div",
            { class: "empty" },
            h("p", null, "Todavía no hay diseños de pantalla."),
            admin ? h("p", { class: "muted" }, "Describe la pantalla LED por gabinetes y el sistema arma la Salida Avanzada de Resolume.") : null,
          ),
        );
      else parts.push(h("div", { class: "scr-list" }, list.map(layoutCard)));
      parts.push(aoCard());
    }
    replaceKeepFocus(el, parts);
  }

  function miniPreview(g) {
    const rs = stageRects(g);
    const b = bbox(rs);
    if (!b.w || !b.h) return null;
    return h(
      "div",
      { class: "scr-mini", "aria-hidden": "true", style: { "--ratio": String(b.w / b.h) } },
      rs.map((r) =>
        h("span", { style: { left: per((r.x - b.x) / b.w), top: per((r.y - b.y) / b.h), width: per(r.w / b.w), height: per(r.h / b.h), "--c": colorOf(r.i) } }),
      ),
    );
  }

  function layoutCard(l) {
    const g = toDraft(l);
    const fit = compFit(g);
    const cabs = l.pieces.reduce((n, p) => n + p.cols * p.rows, 0);
    const meta = [
      ["Gabinete", `${l.cabinetLabel} · ${l.cabinetW}×${l.cabinetH} px`],
      ["Piezas", `${l.pieces.length} (${cabs} gabinetes)`],
      ["Escenario", `${fit.b.w}×${fit.b.h} px`],
      ["Composición", `${l.composition.width}×${l.composition.height}${fit.exact ? " · 1:1" : ` · escala ${scaleText(fit.scale)}`}`],
      ["Salida", `${l.output.width}×${l.output.height}`],
    ];
    const bad = problems(g).filter((p) => p.kind === "bad").length;
    const png = () => downloadTemplate(toDraft(l), l.name);
    const actions = admin
      ? h(
          "div",
          { class: "scr-actions" },
          h("button", { type: "button", class: "btn btn-go scr-send", dataset: { key: `send-${l.id}` }, onclick: () => openSend(l) }, icon("send"), h("span", null, "Enviar a Resolume")),
          h("button", { type: "button", class: "btn", dataset: { key: `edit-${l.id}` }, onclick: () => openEditor(l) }, icon("edit"), h("span", null, "Editar")),
          h("button", { type: "button", class: "btn btn-icon", "aria-label": `Plantilla PNG de ${l.name}`, title: "Plantilla para diseñar (PNG)", dataset: { key: `png-${l.id}` }, onclick: png }, icon("download")),
          h("button", { type: "button", class: "btn btn-ghost btn-icon scr-del", "aria-label": `Borrar ${l.name}`, dataset: { key: `del-${l.id}` }, onclick: () => remove(l) }, icon("trash")),
        )
      : h(
          "div",
          { class: "scr-actions" },
          h("button", { type: "button", class: "btn", dataset: { key: `view-${l.id}` }, onclick: () => openEditor(l) }, icon("eye"), h("span", null, "Ver")),
          h("button", { type: "button", class: "btn", dataset: { key: `png-${l.id}` }, onclick: png }, icon("download"), h("span", null, "Plantilla PNG")),
        );
    return h(
      "article",
      { class: "scr-card card" },
      h("header", { class: "auto-head" }, h("h3", { class: "auto-name" }, l.name || "Sin nombre"), bad ? h("span", { class: "chip chip-warn" }, `${bad} ${bad === 1 ? "aviso" : "avisos"}`) : null),
      miniPreview(g),
      h(
        "dl",
        { class: "auto-meta" },
        meta.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))),
      ),
      actions,
    );
  }

  async function remove(l) {
    const ok = await confirmDialog({ title: `¿Borrar «${l.name}»?`, body: "Se borra el diseño guardado en el puente. Los presets ya enviados a Resolume no se tocan.", ok: "Borrar", danger: true });
    if (!ok) return;
    const r = await cmd({ action: "deleteScreenLayout", id: l.id });
    if (r.ok) toast("Diseño borrado", "ok");
  }

  // ------------------------------------------------------------ Mapeo actual de Resolume
  function aoCard() {
    const body = [];
    if (aoError) body.push(h("p", { class: "form-error", role: "alert" }, aoError));
    if (ao && !ao.found) body.push(h("p", { class: "note" }, "No se encontró la carpeta de Resolume en el PC del puente."));
    if (ao?.found) {
      const meta = [
        ["Composición", ao.composition ? `${ao.composition.width}×${ao.composition.height}` : "—"],
        ["Salida", ao.output ? `${ao.output.name} · ${ao.output.width}×${ao.output.height}` : "—"],
        ["Cortes", String(ao.slices.length)],
      ];
      body.push(
        h(
          "dl",
          { class: "auto-meta" },
          meta.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))),
        ),
      );
      if (ao.resolumeDir) body.push(h("p", { class: "muted small scr-path-line" }, "Carpeta: ", h("span", { class: "mono" }, ao.resolumeDir)));
      if (ao.slices.length)
        body.push(
          h(
            "div",
            { class: "scr-table-wrap", tabindex: "0", role: "region", "aria-label": "Cortes actuales" },
            h(
              "table",
              { class: "scr-table" },
              h("thead", null, h("tr", null, h("th", { scope: "col" }, "Corte"), h("th", { scope: "col" }, "Entrada"), h("th", { scope: "col" }, "Salida"))),
              h(
                "tbody",
                null,
                ao.slices.map((s) =>
                  h(
                    "tr",
                    null,
                    h("td", null, s.name || "—", s.kind === "polygon" ? h("span", { class: "muted" }, " (polígono)") : null),
                    h("td", { class: "mono" }, rectText(s.input)),
                    h("td", { class: "mono" }, rectText(s.output)),
                  ),
                ),
              ),
            ),
          ),
        );
      if (ao.output) body.push(h("p", { class: "muted small" }, `Los diseños nuevos usarán ${ao.output.width}×${ao.output.height} como salida.`));
    }
    return h(
      "section",
      { class: "scr-ao card", "aria-labelledby": "scr-ao-title" },
      h("h3", { id: "scr-ao-title", class: "scr-sec-title" }, "Mapeo actual de Resolume"),
      h("p", { class: "muted small" }, "Lee la Salida Avanzada que Resolume tiene guardada en el PC del puente. Solo lectura."),
      h(
        "button",
        { type: "button", class: "btn", dataset: { key: "scr-ao" }, disabled: aoBusy, "aria-busy": aoBusy ? "true" : null, onclick: importAo },
        icon("down"),
        h("span", null, aoBusy ? "Leyendo…" : ao ? "Volver a leer" : "Importar mapeo actual"),
      ),
      body,
    );
  }

  async function importAo() {
    if (aoBusy) return;
    aoBusy = true;
    aoError = "";
    renderList();
    const r = await cmd({ action: "readAdvancedOutput" }, { quiet: true });
    aoBusy = false;
    if (r.ok && r.data) ao = r.data;
    else aoError = r.error || "No se pudo leer la Salida Avanzada.";
    if (!draft) renderList();
  }

  // ------------------------------------------------------------ Enviar a Resolume
  function closeSend() {
    if (dlg?.open) dlg.close();
    dlg?.remove();
    dlg = null;
  }

  function openSend(l) {
    closeSend();
    let target = "preset";
    let busy = false;
    const fit = compFit(toDraft(l));
    const titleId = "scr-send-title";
    const nameIn = h("input", { type: "text", id: "scr-preset", maxlength: "80", value: l.name, autocomplete: "off", "aria-describedby": "scr-preset-err" });
    const nameErr = h("p", { class: "field-error", id: "scr-preset-err", hidden: true });
    const prefsWarn = h("p", { class: "note scr-note-bad", hidden: true }, "Solo con Resolume cerrado: reemplaza la Salida Avanzada actual (se guarda una copia de respaldo).");
    const errBox = h("p", { class: "form-error", role: "alert", hidden: true });
    const okLabel = h("span", null, "Enviar");
    const okBtn = h("button", { type: "submit", class: "btn btn-go" }, icon("send"), okLabel);
    const cancelBtn = h("button", { type: "button", class: "btn", onclick: () => dlg?.close() }, "Cancelar");
    const radio = (value, label) =>
      h(
        "label",
        { class: "scr-radio" },
        h("input", {
          type: "radio",
          name: "scr-target",
          value,
          checked: value === target,
          onchange: () => {
            target = value;
            prefsWarn.hidden = target !== "preferences";
            okBtn.className = `btn ${target === "preferences" ? "btn-danger" : "btn-go"}`;
            okLabel.textContent = target === "preferences" ? "Reemplazar" : "Enviar";
          },
        }),
        h("span", null, label),
      );
    const form = h(
      "form",
      { class: "dialog-form", novalidate: true, onsubmit: (e) => (e.preventDefault(), send()) },
      h("h2", { id: titleId, class: "dialog-title" }, "Enviar a Resolume"),
      h("p", { class: "dialog-body" }, `Arma la Salida Avanzada de «${l.name}» (${l.pieces.length} ${l.pieces.length === 1 ? "corte" : "cortes"}) y la guarda como preset en el PC del puente. No cambia lo que está al aire.`),
      h("div", { class: "field scr-dlg-field" }, h("label", { for: "scr-preset" }, "Nombre del preset"), nameIn, nameErr),
      h(
        "details",
        { class: "scr-adv" },
        h("summary", null, "Opciones avanzadas"),
        h("fieldset", { class: "field scr-radios" }, h("legend", null, "Dónde guardar"), radio("preset", "Como preset (recomendado)"), radio("preferences", "Reemplazar la Salida Avanzada actual")),
        prefsWarn,
      ),
      errBox,
      h("div", { class: "dialog-actions" }, cancelBtn, okBtn),
    );
    dlg = h("dialog", { class: "dialog scr-dialog", "aria-labelledby": titleId }, form);
    const me = dlg;
    me.addEventListener("close", () => setTimeout(() => me.remove(), 0));
    me.addEventListener("cancel", (e) => busy && e.preventDefault());
    me.addEventListener("click", (e) => {
      if (e.target === me && !busy) me.close();
    });
    document.body.append(me);
    me.showModal();
    nameIn.focus();
    nameIn.select();

    async function send() {
      if (busy) return;
      const presetName = nameIn.value.trim();
      let err = "";
      if (!presetName) err = "Ponle un nombre al preset.";
      else if (/[\\/:*?"<>|]/.test(presetName)) err = 'Sin estos caracteres: \\ / : * ? " < > |';
      nameErr.textContent = err;
      nameErr.hidden = !err;
      if (err) {
        nameIn.setAttribute("aria-invalid", "true");
        nameIn.focus();
        return;
      }
      nameIn.removeAttribute("aria-invalid");
      busy = true;
      errBox.hidden = true;
      okBtn.disabled = true;
      okBtn.setAttribute("aria-busy", "true");
      okLabel.textContent = "Enviando…";
      const r = await cmd({ action: "applyScreenLayout", id: l.id, presetName, target }, { quiet: true });
      busy = false;
      if (dlg !== me) return;
      okBtn.disabled = false;
      okBtn.removeAttribute("aria-busy");
      okLabel.textContent = target === "preferences" ? "Reemplazar" : "Enviar";
      if (!r.ok) {
        errBox.textContent = r.error || "No se pudo enviar a Resolume.";
        errBox.hidden = false;
        return;
      }
      toast("Enviado a Resolume", "ok");
      showDone(me, r.data || {}, presetName, target, l, fit);
    }
  }

  function showDone(me, data, presetName, target, l, fit) {
    const comp = `${l.composition.width}×${l.composition.height}`;
    const steps =
      target === "preferences"
        ? [h("li", null, "Abre Resolume: la Salida Avanzada ya usa este diseño."), h("li", null, `Revisa la composición en Composition → Settings: debe medir ${comp}.`)]
        : [
            h("li", null, `En Resolume: Output → Advanced Output → menú Presets (arriba a la izquierda) → elige «${presetName}».`),
            h("li", null, `Revisa la composición en Composition → Settings: debe medir ${comp}.`),
          ];
    const done = h("button", { type: "button", class: "btn btn-primary btn-block", onclick: () => me.close() }, "Listo");
    fill(me.firstElementChild, 
      h("h2", { id: "scr-send-title", class: "dialog-title" }, "Listo"),
      h("p", { class: "dialog-body" }, `Se guardó ${typeof data.slices === "number" ? `con ${data.slices} ${data.slices === 1 ? "corte" : "cortes"} ` : ""}en:`),
      data.path ? h("p", { class: "scr-path" }, data.path) : null,
      data.backup ? h("p", { class: "muted small" }, "Copia de respaldo: ", h("span", { class: "scr-path-inline mono" }, data.backup)) : null,
      h("ol", { class: "scr-steps" }, steps),
      fit.exact ? null : h("p", { class: "muted small" }, `El escenario (${fit.b.w}×${fit.b.h}) se escala al ${scaleText(fit.scale)} dentro de la composición.`),
      h("div", { class: "scr-dlg-done" }, done),
    );
    done.focus();
  }

  // ------------------------------------------------------------ Editor
  function newDraft() {
    const comp = S.state?.composition;
    const cab = CABINETS.find((c) => c.id === DEFAULT_CAB);
    const d = {
      isNew: true,
      id: uuid(),
      name: "",
      cab: cab.id,
      cabLabel: cab.label,
      cabW: cab.w,
      cabH: cab.h,
      pieces: [{ id: uuid(), name: "Centro", cols: 4, rows: 3, x: 0, y: 0, outX: 0, outY: 0 }],
      compW: comp?.width || 1920,
      compH: comp?.height || 1080,
      outW: ao?.output?.width || 1920,
      outH: ao?.output?.height || 1080,
      outTouched: false,
      view: "stage",
      sel: null,
    };
    d.sel = d.pieces[0].id;
    return d;
  }

  function openEditor(l) {
    draft = l ? toDraft(l) : newDraft();
    draft.readonly = !admin;
    renderEditor();
    if (admin) el.querySelector("#scr-name")?.focus({ preventScroll: true });
    el.scrollIntoView({ block: "start" });
  }

  function closeEditor() {
    draft = null;
    editor = null;
    renderList();
    el.querySelector('[data-key="scr-new"]')?.focus({ preventScroll: true });
  }

  /** Campo numérico entero: actualiza el borrador solo con valores válidos. */
  function numField({ id, label, value, min, max, onValid, onChange = false, help }) {
    const err = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
    const helpEl = help ? h("p", { class: "field-help", id: `${id}-help` }, help) : null;
    const input = h("input", {
      type: "text",
      inputmode: "numeric",
      id,
      value: String(value),
      autocomplete: "off",
      disabled: draft.readonly,
      dataset: { key: id },
      "aria-describedby": [helpEl ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" "),
    });
    const handler = () => {
      const t = input.value.trim();
      const v = /^-?\d+$/.test(t) ? Number(t) : NaN;
      let msg = "";
      if (!Number.isFinite(v)) msg = "Escribe un número entero.";
      else if (v < min || v > max) msg = `Entre ${min} y ${max}.`;
      err.textContent = msg;
      err.hidden = !msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else {
        input.removeAttribute("aria-invalid");
        onValid(v);
      }
    };
    input.addEventListener(onChange ? "change" : "input", handler);
    return h("div", { class: "field" }, h("label", { for: id }, label), input, helpEl, err);
  }

  function renderEditor() {
    const d = draft;
    const ro = d.readonly;

    const nameErr = h("p", { class: "field-error", id: "scr-name-err", hidden: true });
    const nameIn = h("input", { type: "text", id: "scr-name", maxlength: "60", value: d.name, autocomplete: "off", disabled: ro, "aria-describedby": "scr-name-err", oninput: (e) => (d.name = e.target.value) });

    // Gabinete
    const customBox = h("div", { class: "scr-custom", hidden: d.cab !== "custom" });
    const renderCustom = () =>
      fill(customBox, 
        h(
          "div",
          { class: "field-pair" },
          numField({ id: "scr-cabw", label: "Ancho (px)", value: d.cabW, min: 1, max: 4096, onChange: true, onValid: (v) => setCabinet(v, d.cabH) }),
          numField({ id: "scr-cabh", label: "Alto (px)", value: d.cabH, min: 1, max: 4096, onChange: true, onValid: (v) => setCabinet(d.cabW, v) }),
        ),
        h(
          "div",
          { class: "field" },
          h("label", { for: "scr-cablabel" }, "Nombre del gabinete (opcional)"),
          h("input", { type: "text", id: "scr-cablabel", maxlength: "60", value: d.cab === "custom" ? d.cabLabel : "", placeholder: "Ej. Absen PL3.9 500×500", autocomplete: "off", disabled: ro, oninput: (e) => (d.cabLabel = e.target.value) }),
        ),
      );
    renderCustom();
    const cabSel = h(
      "select",
      {
        id: "scr-cab",
        disabled: ro,
        "aria-describedby": "scr-cab-help",
        onchange: (e) => {
          const c = CABINETS.find((x) => x.id === e.target.value);
          d.cab = c.id;
          if (c.id === "custom") {
            d.cabLabel = "";
            renderCustom();
          } else {
            d.cabLabel = c.label;
            setCabinet(c.w, c.h);
          }
          customBox.hidden = c.id !== "custom";
        },
      },
      CABINETS.map((c) => h("option", { value: c.id, selected: c.id === d.cab }, c.w ? `${c.label} · ${c.w}×${c.h} px` : "Personalizado (escribir píxeles)")),
    );

    const pieceList = h("div", { class: "scr-plist", role: "list" });
    const addBtn = ro ? null : h("button", { type: "button", class: "btn btn-block", dataset: { key: "scr-add" }, onclick: () => addPiece(null) }, icon("plus"), h("span", null, "Agregar pieza"));

    // Vistas
    const viewSeg = h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-label": "Vista" },
      ["stage", "output"].map((v) => {
        const id = `scr-view-${v}`;
        return h(
          "span",
          { class: "seg" },
          h("input", {
            type: "radio",
            id,
            name: "scr-view",
            value: v,
            checked: d.view === v,
            onchange: () => {
              d.view = v;
              renderViewHead();
              renderVisual();
            },
          }),
          h("label", { for: id }, v === "stage" ? "Escenario" : "Salida"),
        );
      }),
    );
    const viewHead = h("div", { class: "scr-viewhead" });
    const board = h("div", { class: "scr-board" });
    const boardWrap = h("div", { class: "scr-board-wrap" }, board);
    const boardFoot = h("p", { class: "scr-board-foot muted small mono", "aria-live": "polite" });
    const insp = h("div", { class: "scr-insp" });

    // Composición
    const compBox = h("div", { class: "scr-comp" });
    const warns = h("ul", { class: "scr-warns", "aria-live": "polite" });
    const summaryBox = h("div", { class: "scr-summary" });
    const formErr = h("p", { class: "form-error", role: "alert", hidden: true, tabindex: "-1" });

    const png = h(
      "button",
      { type: "button", class: "btn btn-block scr-png", onclick: () => downloadTemplate(d, d.name.trim() || "pantalla") },
      icon("download"),
      h("span", null, "Plantilla para diseñar (PNG)"),
    );

    const actions = ro
      ? h("div", { class: "editor-actions" }, h("button", { type: "button", class: "btn", onclick: closeEditor }, icon("back"), h("span", null, "Volver")), h("span"))
      : h(
          "div",
          { class: "editor-actions" },
          h("button", { type: "button", class: "btn", onclick: closeEditor }, "Cancelar"),
          h("button", { type: "submit", class: "btn btn-primary", "data-save": "" }, icon("check"), h("span", null, "Guardar")),
        );

    const form = h(
      "form",
      {
        class: `editor card scr-editor ${ro ? "is-readonly" : ""}`,
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          save();
        },
      },
      h("h2", { class: "section-title" }, ro ? d.name || "Pantalla" : d.isNew ? "Nueva pantalla" : "Editar pantalla"),
      h("div", { class: "field" }, h("label", { for: "scr-name" }, "Nombre del diseño"), nameIn, nameErr),
      h(
        "div",
        { class: "field" },
        h("label", { for: "scr-cab" }, "Gabinete"),
        cabSel,
        h("p", { class: "field-help", id: "scr-cab-help" }, "Píxeles de cada gabinete. Si lo cambias, las piezas conservan su tamaño en gabinetes."),
      ),
      customBox,
      h(
        "fieldset",
        { class: "field scr-sec" },
        h("legend", null, "Piezas"),
        h("p", { class: "field-help" }, "Cada pieza es un rectángulo de gabinetes (ancho × alto). Una forma en L o Γ se arma con dos piezas."),
        pieceList,
        addBtn,
      ),
      h(
        "section",
        { class: "scr-sec", "aria-label": "Vista de las piezas" },
        viewSeg,
        viewHead,
        boardWrap,
        boardFoot,
        insp,
      ),
      h("section", { class: "scr-sec", "aria-labelledby": "scr-comp-title" }, h("h3", { id: "scr-comp-title", class: "scr-sec-title" }, "Composición de Resolume"), compBox),
      h("section", { class: "scr-sec", "aria-labelledby": "scr-warn-title" }, h("h3", { id: "scr-warn-title", class: "scr-sec-title" }, "Revisión"), warns),
      h("section", { class: "scr-sec", "aria-labelledby": "scr-sum-title" }, h("h3", { id: "scr-sum-title", class: "scr-sec-title" }, "Resumen por pieza"), summaryBox),
      png,
      formErr,
      actions,
    );

    editor = { form, nameIn, nameErr, pieceList, viewHead, board, boardFoot, insp, compBox, warns, summaryBox, formErr, ex: null };
    fill(el, form);
    renderPieces();
    renderViewHead();
    renderVisual();
  }

  // ---- Piezas
  function renderPieces() {
    if (!editor) return;
    const d = draft;
    const ro = d.readonly;
    const rows = d.pieces.map((p, i) => {
      const size = h("span", { class: "scr-psize mono" }, `${pieceW(d, p)}×${pieceH(d, p)} px`);
      const refreshSize = () => (size.textContent = `${pieceW(d, p)}×${pieceH(d, p)} px`);
      const nameId = `scr-pn-${p.id}`;
      return h(
        "div",
        { class: `scr-prow ${p.id === d.sel ? "is-selected" : ""}`, role: "listitem", style: { "--c": colorOf(i) } },
        h(
          "div",
          { class: "scr-prow-top" },
          h(
            "div",
            { class: "field" },
            h("label", { for: nameId }, `Pieza ${i + 1}`),
            h("input", {
              type: "text",
              id: nameId,
              maxlength: "40",
              value: p.name,
              placeholder: `Pieza ${i + 1}`,
              autocomplete: "off",
              disabled: ro,
              dataset: { key: nameId },
              oninput: (e) => {
                p.name = e.target.value;
                renderVisual({ skipInspector: false });
              },
              onfocus: () => select(p.id, { quiet: true }),
            }),
          ),
          ro
            ? null
            : h(
                "div",
                { class: "scr-prow-btns" },
                h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": `Duplicar ${p.name || `pieza ${i + 1}`}`, title: "Duplicar", dataset: { key: `dup-${p.id}` }, onclick: () => addPiece(p) }, icon("copy")),
                h("button", { type: "button", class: "btn btn-ghost btn-icon scr-del", "aria-label": `Quitar ${p.name || `pieza ${i + 1}`}`, title: "Quitar", dataset: { key: `rm-${p.id}` }, onclick: () => removePiece(p) }, icon("trash")),
              ),
        ),
        h(
          "div",
          { class: "scr-prow-dims" },
          numField({
            id: `scr-pc-${p.id}`,
            label: "Ancho (gab.)",
            value: p.cols,
            min: 1,
            max: MAX_CAB,
            onValid: (v) => {
              p.cols = v;
              refreshSize();
              afterResize();
            },
          }),
          numField({
            id: `scr-pr-${p.id}`,
            label: "Alto (gab.)",
            value: p.rows,
            min: 1,
            max: MAX_CAB,
            onValid: (v) => {
              p.rows = v;
              refreshSize();
              afterResize();
            },
          }),
          size,
        ),
      );
    });
    replaceKeepFocus(editor.pieceList, rows.length ? rows : h("p", { class: "muted small" }, "Sin piezas. Agrega al menos una."));
  }

  function afterResize() {
    if (!draft.outTouched) autoPack(draft);
    renderVisual();
  }

  function addPiece(copyOf) {
    const d = draft;
    const b = bbox(stageRects(d));
    const n = d.pieces.length + 1;
    const p = {
      id: uuid(),
      name: copyOf ? `${copyOf.name || "Pieza"} (copia)`.slice(0, 40) : `Pieza ${n}`,
      cols: copyOf?.cols ?? 2,
      rows: copyOf?.rows ?? 2,
      x: d.pieces.length ? b.x + b.w : 0,
      y: copyOf ? copyOf.y : d.pieces.length ? b.y : 0,
      outX: 0,
      outY: 0,
    };
    if (d.outTouched) p.outY = Math.max(0, ...outRects(d).map((r) => r.y + r.h));
    d.pieces.push(p);
    if (!d.outTouched) autoPack(d);
    d.sel = p.id;
    renderPieces();
    renderVisual();
    const input = editor.pieceList.querySelector(`#scr-pn-${CSS.escape(p.id)}`);
    input?.focus({ preventScroll: true });
    input?.select();
    input?.scrollIntoView({ block: "nearest" });
  }

  function removePiece(p) {
    const d = draft;
    d.pieces = d.pieces.filter((x) => x !== p);
    if (d.sel === p.id) d.sel = d.pieces[0]?.id ?? null;
    if (!d.outTouched) autoPack(d);
    renderPieces();
    renderVisual();
    toast(`Se quitó «${p.name || "pieza"}»`, "info");
    editor.form.querySelector('[data-key="scr-add"]')?.focus({ preventScroll: true });
  }

  /** Cambia el gabinete conservando las posiciones en gabinetes. */
  function setCabinet(w, hh) {
    const d = draft;
    const fx = w / d.cabW;
    const fy = hh / d.cabH;
    if (fx !== 1 || fy !== 1)
      for (const p of d.pieces) {
        p.x = Math.round(p.x * fx);
        p.y = Math.round(p.y * fy);
        p.outX = Math.round(p.outX * fx);
        p.outY = Math.round(p.outY * fy);
      }
    d.cabW = w;
    d.cabH = hh;
    if (!d.outTouched) autoPack(d);
    renderPieces();
    renderVisual();
  }

  function select(id, { quiet = false } = {}) {
    if (draft.sel === id) return;
    draft.sel = id;
    for (const row of editor.pieceList.children) row.classList.remove("is-selected");
    const i = draft.pieces.findIndex((p) => p.id === id);
    editor.pieceList.children[i]?.classList.add("is-selected");
    if (quiet) {
      for (const b of editor.board.querySelectorAll(".scr-piece")) {
        const on = b.dataset.id === id;
        b.classList.toggle("is-selected", on);
        b.setAttribute("aria-pressed", String(on));
      }
      renderInspector();
    } else renderVisual();
  }

  // ---- Vista (escenario / salida)
  function renderViewHead() {
    const d = draft;
    const ro = d.readonly;
    if (d.view === "stage") {
      fill(editor.viewHead, h("p", { class: "field-help" }, ro ? "Cómo se ve afuera." : "Cómo se ve afuera. Arrastra las piezas (se ajustan a ¼ de gabinete) o escribe su posición. Los huecos entre piezas se respetan."));
      return;
    }
    const aoOut = ao?.output;
    fill(editor.viewHead, 
      h("p", { class: "field-help" }, ro ? "Lo que recibe el procesador LED, píxel a píxel." : "Lo que recibe el procesador LED, píxel a píxel. Arrastra (ajuste de 8 px y a los bordes vecinos) o usa Acomodar automático."),
      h(
        "div",
        { class: "field-pair scr-outsize" },
        numField({ id: "scr-outw", label: "Salida: ancho", value: d.outW, min: 16, max: MAX_PX, onValid: (v) => ((d.outW = v), afterOutSize()) }),
        numField({ id: "scr-outh", label: "Salida: alto", value: d.outH, min: 16, max: MAX_PX, onValid: (v) => ((d.outH = v), afterOutSize()) }),
      ),
      ro
        ? null
        : h(
            "div",
            { class: "chip-row scr-outchips", role: "group", "aria-label": "Tamaños de salida" },
            aoOut ? h("button", { type: "button", class: "chip-btn", onclick: () => setOut(aoOut.width, aoOut.height) }, `De Resolume: ${aoOut.name} ${aoOut.width}×${aoOut.height}`) : null,
            [
              [1920, 1080],
              [3840, 2160],
              [1920, 1200],
            ].map(([w, hh]) => h("button", { type: "button", class: "chip-btn", onclick: () => setOut(w, hh) }, `${w}×${hh}`)),
          ),
      ro
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "btn btn-block",
              dataset: { key: "scr-pack" },
              onclick: () => {
                autoPack(draft);
                draft.outTouched = false;
                renderVisual();
                toast("Piezas acomodadas en la salida", "ok");
              },
            },
            icon("grid"),
            h("span", null, "Acomodar automático"),
          ),
    );
  }

  function setOut(w, hh) {
    draft.outW = w;
    draft.outH = hh;
    renderViewHead();
    afterOutSize();
  }

  function afterOutSize() {
    if (!draft.outTouched) autoPack(draft);
    renderVisual();
  }

  /** Área visible del tablero, en píxeles del diseño. */
  function extents(isOut) {
    const d = draft;
    const rs = isOut ? outRects(d) : stageRects(d);
    if (isOut) {
      const b = bbox([...rs, { x: 0, y: 0, w: d.outW, h: d.outH }]);
      const m = Math.max(b.w, b.h) * 0.015;
      return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
    }
    if (!rs.length) return { x: 0, y: 0, w: d.cabW * 8, h: d.cabH * 4 };
    const b = bbox(rs);
    const mx = Math.max(d.cabW * 1.5, b.w * 0.06);
    const my = Math.max(d.cabH * 1.5, b.h * 0.06);
    return { x: b.x - mx, y: b.y - my, w: b.w + 2 * mx, h: b.h + 2 * my };
  }

  const posStyle = (r, ex) => ({ left: per((r.x - ex.x) / ex.w), top: per((r.y - ex.y) / ex.h), width: per(r.w / ex.w), height: per(r.h / ex.h) });

  function renderVisual({ skipInspector = false } = {}) {
    if (!editor) return;
    renderBoard();
    if (!skipInspector) renderInspector();
    renderComp();
    renderWarnings();
    renderSummary();
  }

  function renderBoard() {
    const d = draft;
    const isOut = d.view === "output";
    const ex = extents(isOut);
    editor.ex = ex;
    const badIds = new Set(problems(d).flatMap((p) => p.ids));
    const rs = isOut ? outRects(d) : stageRects(d);
    const frameRect = isOut ? { x: 0, y: 0, w: d.outW, h: d.outH } : bbox(rs);
    const frame =
      frameRect.w && frameRect.h
        ? h(
            "div",
            { class: `scr-frame ${isOut ? "is-output" : ""}`, style: posStyle(frameRect, ex), "aria-hidden": "true" },
            h("span", { class: "scr-frame-label mono" }, isOut ? `Salida ${d.outW}×${d.outH}` : `Escenario ${frameRect.w}×${frameRect.h}`),
          )
        : null;
    const pieces = rs.map((r) => {
      const p = r.p;
      const sel = p.id === d.sel;
      const bad = isOut && badIds.has(p.id);
      const b = h(
        "button",
        {
          type: "button",
          class: `scr-piece ${sel ? "is-selected" : ""} ${bad ? "is-bad" : ""}`,
          dataset: { key: `pc-${p.id}`, id: p.id },
          "aria-pressed": String(sel),
          "aria-label": `${nameOf(r)}, ${r.w}×${r.h} px, en ${r.x}, ${r.y}${bad ? ", con problemas" : ""}`,
          style: { ...posStyle(r, ex), "--c": colorOf(r.i) },
          onclick: () => select(p.id),
          onkeydown: (e) => onPieceKey(e, p),
          onpointerdown: (e) => startDrag(e, p),
        },
        h("span", { class: "scr-piece-name" }, nameOf(r)),
        h("span", { class: "scr-piece-size" }, `${r.w}×${r.h}`),
      );
      return b;
    });
    editor.board.style.setProperty("--ratio", String(ex.w / ex.h));
    replaceKeepFocus(editor.board, frame, pieces);
    const fit = compFit(d);
    editor.boardFoot.textContent = isOut
      ? `Salida ${d.outW}×${d.outH} · usada ${bbox(rs).w}×${bbox(rs).h}`
      : `Escenario ${fit.b.w}×${fit.b.h} px · ${d.pieces.reduce((n, p) => n + p.cols * p.rows, 0)} gabinetes`;
  }

  function moveTo(p, isOut, x, y) {
    if (isOut) {
      p.outX = Math.max(0, Math.round(x));
      p.outY = Math.max(0, Math.round(y));
    } else {
      p.x = Math.round(x);
      p.y = Math.round(y);
    }
  }

  function snapStage(x, y) {
    const sx = draft.cabW / 4;
    const sy = draft.cabH / 4;
    return [Math.round(x / sx) * sx, Math.round(y / sy) * sy];
  }

  /** Ajuste de 8 px y a los bordes de la salida y de las otras piezas. */
  function snapOut(p, x, y, k) {
    const d = draft;
    const w = pieceW(d, p);
    const hh = pieceH(d, p);
    const th = Math.max(MAGNET, 10 * k);
    const xs = [0, d.outW - w];
    const ys = [0, d.outH - hh];
    for (const q of d.pieces) {
      if (q === p) continue;
      const qw = pieceW(d, q);
      const qh = pieceH(d, q);
      xs.push(q.outX + qw, q.outX - w, q.outX);
      ys.push(q.outY + qh, q.outY - hh, q.outY);
    }
    const near = (v, cands) => {
      let best = null;
      for (const c of cands) if (c >= 0 && Math.abs(c - v) <= th && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
      return best;
    };
    return [near(x, xs) ?? Math.round(x / OUT_SNAP) * OUT_SNAP, near(y, ys) ?? Math.round(y / OUT_SNAP) * OUT_SNAP];
  }

  function startDrag(e, p) {
    if (draft.readonly || e.button > 0 || !editor) return;
    const btn = e.currentTarget;
    const isOut = draft.view === "output";
    const ex = editor.ex;
    const box = editor.board.getBoundingClientRect();
    const kx = ex.w / box.width;
    const ky = ex.h / box.height;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = isOut ? p.outX : p.x;
    const oy = isOut ? p.outY : p.y;
    let moved = false;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: igual funciona dentro del botón */
    }
    btn.focus({ preventScroll: true });
    select(p.id, { quiet: true });
    const onMove = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      btn.classList.add("is-dragging");
      const [nx, ny] = isOut ? snapOut(p, ox + dx * kx, oy + dy * ky, kx) : snapStage(ox + dx * kx, oy + dy * ky);
      moveTo(p, isOut, nx, ny);
      const r = { x: isOut ? p.outX : p.x, y: isOut ? p.outY : p.y, w: pieceW(draft, p), h: pieceH(draft, p) };
      for (const [k, v] of Object.entries(posStyle(r, ex))) btn.style.setProperty(k, v);
      renderInspector();
    };
    const onUp = () => {
      btn.removeEventListener("pointermove", onMove);
      btn.removeEventListener("pointerup", onUp);
      btn.removeEventListener("pointercancel", onUp);
      if (!editor) return;
      if (moved) {
        if (isOut) draft.outTouched = true;
        renderVisual();
      }
    };
    btn.addEventListener("pointermove", onMove);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
  }

  function onPieceKey(e, p) {
    if (draft.readonly) return;
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = dirs[e.key];
    if (!dir) return;
    e.preventDefault();
    const isOut = draft.view === "output";
    const stepX = isOut ? (e.shiftKey ? 64 : OUT_SNAP) : e.shiftKey ? draft.cabW : draft.cabW / 4;
    const stepY = isOut ? (e.shiftKey ? 64 : OUT_SNAP) : e.shiftKey ? draft.cabH : draft.cabH / 4;
    draft.sel = p.id;
    moveTo(p, isOut, (isOut ? p.outX : p.x) + dir[0] * stepX, (isOut ? p.outY : p.y) + dir[1] * stepY);
    if (isOut) draft.outTouched = true;
    renderVisual();
  }

  function renderInspector() {
    if (!editor) return;
    const d = draft;
    const isOut = d.view === "output";
    const p = d.pieces.find((x) => x.id === d.sel);
    const pick = d.pieces.length
      ? h(
          "div",
          { class: "field" },
          h("label", { for: "scr-sel" }, "Pieza elegida"),
          h(
            "select",
            { id: "scr-sel", dataset: { key: "scr-sel" }, onchange: (e) => select(e.target.value) },
            p ? null : h("option", { value: "", selected: true }, "Elige una pieza"),
            d.pieces.map((q, i) => h("option", { value: q.id, selected: q.id === d.sel }, q.name.trim() || `Pieza ${i + 1}`)),
          ),
        )
      : null;
    if (!p) {
      replaceKeepFocus(editor.insp, pick, h("p", { class: "muted small" }, d.pieces.length ? "Toca una pieza para elegirla." : "Agrega una pieza para empezar."));
      return;
    }
    const lim = isOut ? [0, MAX_PX] : [-MAX_PX, MAX_PX];
    const xy = h(
      "div",
      { class: "field-pair" },
      numField({ id: `scr-x-${d.view}`, label: isOut ? "X en la salida" : "X en el escenario", value: isOut ? p.outX : p.x, min: lim[0], max: lim[1], onValid: (v) => setPos(p, isOut, v, null) }),
      numField({ id: `scr-y-${d.view}`, label: isOut ? "Y en la salida" : "Y en el escenario", value: isOut ? p.outY : p.y, min: lim[0], max: lim[1], onValid: (v) => setPos(p, isOut, null, v) }),
    );
    replaceKeepFocus(editor.insp, pick, xy, d.readonly ? null : h("p", { class: "field-help" }, isOut ? "Flechas del teclado: 8 px (Mayús: 64 px)." : "Flechas del teclado: ¼ de gabinete (Mayús: 1 gabinete)."));
  }

  function setPos(p, isOut, x, y) {
    if (isOut) {
      if (x !== null) p.outX = x;
      if (y !== null) p.outY = y;
      draft.outTouched = true;
    } else {
      if (x !== null) p.x = x;
      if (y !== null) p.y = y;
    }
    renderVisual({ skipInspector: true });
  }

  // ---- Composición
  function renderComp() {
    const d = draft;
    const ro = d.readonly;
    const fit = compFit(d);
    const fields = h(
      "div",
      { class: "field-pair" },
      numField({ id: "scr-compw", label: "Ancho", value: d.compW, min: 16, max: MAX_PX, onValid: (v) => ((d.compW = v), renderVisual({ skipInspector: true })) }),
      numField({ id: "scr-comph", label: "Alto", value: d.compH, min: 16, max: MAX_PX, onValid: (v) => ((d.compH = v), renderVisual({ skipInspector: true })) }),
    );
    // No reconstruir los campos mientras se escribe en ellos.
    const active = document.activeElement;
    const typing = active && editor.compBox.contains(active) && active.tagName === "INPUT";
    const stageLine = h("p", { class: "scr-stage-size" }, "Escenario: ", h("strong", { class: "mono" }, fit.b.w && fit.b.h ? `${fit.b.w}×${fit.b.h} px` : "—"), h("span", { class: "muted" }, " (todo lo que ocupan las piezas, con sus huecos)"));
    let note;
    if (!fit.b.w || !fit.b.h) note = null;
    else if (fit.exact) note = h("p", { class: "note scr-note-ok" }, "1:1 — cada píxel del LED es un píxel de la composición. Los visuales no se deforman ni pierden resolución.");
    else {
      const bars = d.compW / fit.b.w > d.compH / fit.b.h ? "a los lados" : "arriba y abajo";
      const same = Math.abs(d.compW / d.compH - fit.b.w / fit.b.h) < 0.002;
      note = h(
        "p",
        { class: "note" },
        `La composición (${d.compW}×${d.compH}) no mide lo mismo que el escenario (${fit.b.w}×${fit.b.h}). El escenario se escala de forma uniforme para caber, centrado: escala ${scaleText(fit.scale)}`,
        fit.scale < 1 ? " (se pierde resolución)" : " (los visuales se amplían)",
        same ? "." : `; sobra espacio ${bars}.`,
        " Recomendado: usar el tamaño exacto.",
      );
    }
    const exactBtn = ro
      ? null
      : h(
          "button",
          {
            type: "button",
            class: "btn btn-block",
            dataset: { key: "scr-exact" },
            disabled: fit.exact || !fit.b.w,
            onclick: () => {
              d.compW = fit.b.w;
              d.compH = fit.b.h;
              renderVisual();
              toast(`Composición ${d.compW}×${d.compH} (1:1)`, "ok");
            },
          },
          icon("check"),
          h("span", null, "Usar tamaño exacto del escenario"),
        );
    if (typing) {
      // Solo refrescar lo que no es el campo en edición.
      const [, , ...rest] = editor.compBox.children;
      for (const n of rest) n.remove();
      editor.compBox.children[0].replaceWith(stageLine);
      editor.compBox.append(...[exactBtn, note].filter(Boolean));
      return;
    }
    replaceKeepFocus(editor.compBox, stageLine, fields, exactBtn, note);
  }

  function renderWarnings() {
    const d = draft;
    const list = problems(d);
    const items = [];
    if (!d.pieces.length) items.push(h("li", { class: "note scr-note-bad" }, "Agrega al menos una pieza."));
    for (const p of list) items.push(h("li", { class: `note ${p.kind === "bad" ? "scr-note-bad" : ""}` }, p.text));
    if (d.pieces.length && !list.length) items.push(h("li", { class: "note scr-note-ok" }, "Sin problemas: ninguna pieza se pisa ni se sale de la salida."));
    items.push(h("li", { class: "muted small scr-warn-fixed" }, "Las piezas siempre caben en la composición: el escenario se escala para entrar."));
    fill(editor.warns, ...items);
  }

  function renderSummary() {
    const d = draft;
    if (!d.pieces.length) {
      fill(editor.summaryBox, h("p", { class: "muted small" }, "Sin piezas."));
      return;
    }
    const fit = compFit(d);
    const outs = outRects(d);
    fill(editor.summaryBox, 
      h(
        "div",
        { class: "scr-table-wrap", tabindex: "0", role: "region", "aria-label": "Resumen por pieza" },
        h(
          "table",
          { class: "scr-table" },
          h(
            "thead",
            null,
            h("tr", null, ["Pieza", "Gabinetes", "Píxeles", "En composición", "En salida"].map((t) => h("th", { scope: "col" }, t))),
          ),
          h(
            "tbody",
            null,
            fit.rects.map((r, i) =>
              h(
                "tr",
                null,
                h("th", { scope: "row" }, h("span", { class: "scr-swatch", style: { "--c": colorOf(r.i) } }), nameOf(r)),
                h("td", { class: "mono" }, `${r.p.cols}×${r.p.rows}`),
                h("td", { class: "mono" }, `${pieceW(d, r.p)}×${pieceH(d, r.p)}`),
                h("td", { class: "mono" }, rectText(r)),
                h("td", { class: "mono" }, rectText(outs[i])),
              ),
            ),
          ),
        ),
      ),
      h("p", { class: "muted small" }, `Composición ${d.compW}×${d.compH}${fit.exact ? " (1:1)" : ` · escala ${scaleText(fit.scale)}`} · salida ${d.outW}×${d.outH}. Posiciones: x, y · ancho×alto.`),
    );
  }

  // ---- Guardar
  async function save() {
    const d = draft;
    const { form, nameIn, nameErr, formErr } = editor;
    const nm = d.name.trim();
    nameErr.textContent = nm ? "" : "Ponle un nombre.";
    nameErr.hidden = !!nm;
    if (nm) nameIn.removeAttribute("aria-invalid");
    else nameIn.setAttribute("aria-invalid", "true");
    const invalid = [...form.querySelectorAll('[aria-invalid="true"]')];
    let msg = "";
    if (invalid.length) msg = "Revisa los campos marcados.";
    else if (!d.pieces.length) msg = "Agrega al menos una pieza.";
    if (msg) {
      formErr.textContent = msg;
      formErr.hidden = false;
      (invalid[0] || formErr).focus();
      return;
    }
    formErr.hidden = true;
    const minX = Math.min(...d.pieces.map((p) => p.x));
    const minY = Math.min(...d.pieces.map((p) => p.y));
    const cabLabel = d.cab === "custom" ? d.cabLabel.trim() || `Personalizado ${d.cabW}×${d.cabH} px` : CABINETS.find((c) => c.id === d.cab).label;
    const layout = {
      id: d.id,
      name: nm,
      cabinetLabel: cabLabel,
      cabinetW: d.cabW,
      cabinetH: d.cabH,
      pieces: d.pieces.map((p, i) => ({ id: p.id, name: p.name.trim() || `Pieza ${i + 1}`, cols: p.cols, rows: p.rows, x: p.x - minX, y: p.y - minY, outX: p.outX, outY: p.outY })),
      composition: { width: d.compW, height: d.compH },
      output: { width: d.outW, height: d.outH },
    };
    const btn = form.querySelector("[data-save]");
    btn.disabled = true;
    const r = await cmd({ action: "saveScreenLayout", layout });
    if (!editor) return;
    btn.disabled = false;
    if (r.ok) {
      const bad = problems(d).filter((p) => p.kind === "bad").length;
      toast(bad ? `Diseño guardado, con ${bad} ${bad === 1 ? "aviso" : "avisos"} en la salida` : "Diseño guardado", bad ? "info" : "ok", bad ? 5000 : 3500);
      closeEditor();
    }
  }

  function update() {
    if (draft && editor) return;
    renderList();
  }

  /** Al salir del evento o perder el rol se descarta el borrador. */
  function reset() {
    draft = null;
    editor = null;
    closeSend();
  }

  renderList();
  return { el, update, reset };
}
