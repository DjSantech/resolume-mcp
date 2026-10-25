// Pestaña Automatizaciones: lista (Iniciar/Editar/Borrar), en curso y editor.

import { S, isAdmin } from "../store.js";
import { cmd, thumbs } from "../api.js";
import { runnerCard } from "../runner.js";
import { confirmDialog, toast } from "../ui.js";
import { h, icon, minutesText, mmss, replaceKeepFocus, uuid } from "../util.js";

const MIN_SECONDS = 10;

const minutesStr = (sec) => String(Math.round((sec / 60) * 100) / 100).replace(".", ",");
const parseMinutes = (txt) => {
  const t = String(txt).trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return NaN;
  return Number(t);
};

export function createAutosTab() {
  const admin = isAdmin();
  const el = h("div", { class: "autos" });
  /** Borrador en edición (null = lista). */
  let draft = null;
  let editor = null;
  const busy = new Set();

  // ------------------------------------------------------------ Lista
  function renderList() {
    const st = S.state;
    const autos = [...(st?.automations || [])].sort((a, b) => a.name.localeCompare(b.name, "es"));
    const runner = st?.runner || null;
    const parts = [];
    if (runner) parts.push(runnerCard(runner));
    parts.push(
      h(
        "div",
        { class: "section-head" },
        h("h2", { class: "section-title" }, "Automatizaciones"),
        admin
          ? h(
              "button",
              { type: "button", class: "btn btn-primary", dataset: { key: "auto-new" }, onclick: () => openEditor(null) },
              icon("plus"),
              h("span", null, "Nueva"),
            )
          : null,
      ),
    );
    if (!st) parts.push(h("p", { class: "empty" }, "Cargando…"));
    else if (!autos.length)
      parts.push(
        h(
          "div",
          { class: "empty" },
          h("p", null, "Todavía no hay automatizaciones."),
          admin ? h("p", { class: "muted" }, "Crea una para que el puente lance clips solo, uno tras otro.") : null,
        ),
      );
    else parts.push(h("div", { class: "auto-list" }, autos.map((a) => autoCard(a, runner))));
    replaceKeepFocus(el, parts);
  }

  function layerLabel(index) {
    const l = S.state?.composition?.layers.find((x) => x.index === index);
    return l ? `L${index} · ${l.name}` : `Capa ${index}`;
  }

  /** @param {import("../store.js").Automation} a */
  function autoCard(a, runner) {
    const running = runner?.automationId === a.id;
    const meta = [
      ["Pestaña", a.deckName || "La que esté abierta"],
      ["Capa", layerLabel(a.layer)],
      ["Clips", a.clips.length ? `${a.clips.length} elegidos` : "Todos los de la capa"],
      ["Orden", a.order === "shuffle" ? "Al azar" : "En orden"],
      ["Tiempo", `${minutesText(a.minSeconds)} – ${minutesText(a.maxSeconds)} por clip`],
      ["Ajuste", a.fit ? "Ajustar a pantalla" : "Sin ajuste"],
    ];
    const actions = admin
      ? h(
          "div",
          { class: "auto-actions" },
          running
            ? null
            : h(
                "button",
                { type: "button", class: "btn btn-go", dataset: { key: `start-${a.id}` }, onclick: () => start(a) },
                icon("play"),
                h("span", null, "Iniciar"),
              ),
          h(
            "button",
            { type: "button", class: "btn", dataset: { key: `edit-${a.id}` }, onclick: () => openEditor(a) },
            icon("edit"),
            h("span", null, "Editar"),
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost btn-icon",
              "aria-label": `Borrar ${a.name}`,
              dataset: { key: `del-${a.id}` },
              onclick: () => remove(a),
            },
            icon("trash"),
          ),
        )
      : null;
    return h(
      "article",
      { class: `auto-card card ${running ? "is-running" : ""}` },
      h(
        "header",
        { class: "auto-head" },
        h("h3", { class: "auto-name" }, a.name || "Sin nombre"),
        running ? h("span", { class: "tally tally-auto" }, "EN CURSO") : null,
      ),
      h(
        "dl",
        { class: "auto-meta" },
        meta.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))),
      ),
      actions,
    );
  }

  async function start(a) {
    const runner = S.state?.runner;
    if (runner && runner.automationId !== a.id) {
      const ok = await confirmDialog({
        title: "¿Reemplazar la automatización?",
        body: `Está corriendo «${runner.automationName}». Si inicias «${a.name}», la reemplaza.`,
        ok: "Reemplazar",
      });
      if (!ok) return;
    }
    if (busy.has(a.id)) return;
    busy.add(a.id);
    const r = await cmd({ action: "startAutomation", id: a.id });
    busy.delete(a.id);
    if (r.ok) toast(`«${a.name}» iniciada`, "ok");
  }

  async function remove(a) {
    const ok = await confirmDialog({
      title: `¿Borrar «${a.name}»?`,
      body: "No se puede deshacer.",
      ok: "Borrar",
      danger: true,
    });
    if (!ok) return;
    const r = await cmd({ action: "deleteAutomation", id: a.id });
    if (r.ok) toast("Automatización borrada", "ok");
  }

  // ------------------------------------------------------------ Editor
  /** @param {import("../store.js").Automation | null} a */
  function openEditor(a) {
    const comp = S.state?.composition;
    const topLayer = comp?.layers.length ? Math.max(...comp.layers.map((l) => l.index)) : 1;
    draft = a
      ? {
          isNew: false,
          id: a.id,
          name: a.name,
          deckName: a.deckName,
          layer: a.layer,
          clips: a.clips.map((c) => ({ ...c })),
          min: minutesStr(a.minSeconds),
          max: minutesStr(a.maxSeconds),
          order: a.order,
          fit: a.fit,
        }
      : { isNew: true, id: uuid(), name: "", deckName: "", layer: topLayer, clips: [], min: "1", max: "2", order: "sequential", fit: true };
    renderEditor();
    el.querySelector("#ed-name")?.focus();
    el.scrollIntoView({ block: "start" });
  }

  function closeEditor() {
    draft = null;
    editor = null;
    renderList();
    el.querySelector('[data-key="auto-new"]')?.focus({ preventScroll: true });
  }

  function field(id, label, input, help) {
    const err = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
    const helpEl = help ? h("p", { class: "field-help", id: `${id}-help` }, help) : null;
    input.id = id;
    input.setAttribute("aria-describedby", [helpEl ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" "));
    return { wrap: h("div", { class: "field" }, h("label", { for: id }, label), input, helpEl, err), input, err };
  }

  function renderEditor() {
    const comp = S.state?.composition;
    const d = draft;

    const name = field(
      "ed-name",
      "Nombre",
      h("input", { type: "text", maxlength: "60", value: d.name, autocomplete: "off", oninput: (e) => (d.name = e.target.value) }),
    );

    const deckInput = h("input", {
      type: "text",
      maxlength: "80",
      value: d.deckName,
      placeholder: "Vacío = la que esté abierta",
      autocomplete: "off",
      oninput: (e) => {
        d.deckName = e.target.value;
        updateDeckNote();
      },
    });
    const deck = field("ed-deck", "Pestaña a abrir al arrancar", deckInput);
    const deckChips = h(
      "div",
      { class: "chip-row", role: "group", "aria-label": "Elegir pestaña existente" },
      h("button", { type: "button", class: "chip-btn", onclick: () => setDeck("") }, "La abierta"),
      (comp?.decks || []).map((dk) => h("button", { type: "button", class: "chip-btn", onclick: () => setDeck(dk.name) }, dk.name)),
    );
    deck.wrap.append(deckChips);
    function setDeck(v) {
      d.deckName = v;
      deckInput.value = v;
      updateDeckNote();
    }

    const layers = comp ? [...comp.layers].sort((a, b) => b.index - a.index) : [];
    const layerSel = h(
      "select",
      {
        onchange: (e) => {
          const next = Number(e.target.value);
          if (next !== d.layer && d.clips.length) toast("Se quitó la selección de clips (era de otra capa)", "info");
          d.layer = next;
          d.clips = [];
          renderPicker();
        },
      },
      layers.map((l) => h("option", { value: String(l.index), selected: l.index === d.layer }, `L${l.index} · ${l.name}`)),
      layers.some((l) => l.index === d.layer) ? null : h("option", { value: String(d.layer), selected: true }, `Capa ${d.layer}`),
    );
    const layer = field("ed-layer", "Capa", layerSel);

    const deckNote = h("p", { class: "note", hidden: true });
    const picker = h("div", { class: "picker" });
    const clipsSet = h(
      "fieldset",
      { class: "field" },
      h("legend", null, "Clips"),
      h("p", { class: "field-help" }, "De la pestaña abierta. Ninguno marcado = todos los de la capa (se relee en cada vuelta)."),
      deckNote,
      picker,
    );

    const orderSet = h(
      "fieldset",
      { class: "field" },
      h("legend", null, "Orden"),
      h(
        "div",
        { class: "segmented" },
        radio("ed-order", "sequential", "En orden", d.order === "sequential"),
        radio("ed-order", "shuffle", "Al azar", d.order === "shuffle"),
      ),
    );
    function radio(nameAttr, value, label, checked) {
      const id = `${nameAttr}-${value}`;
      return h(
        "span",
        { class: "seg" },
        h("input", { type: "radio", id, name: nameAttr, value, checked, onchange: () => (d.order = value) }),
        h("label", { for: id }, label),
      );
    }

    const min = field(
      "ed-min",
      "Mínimo (min)",
      h("input", { type: "text", inputmode: "decimal", value: d.min, autocomplete: "off", oninput: (e) => (d.min = e.target.value) }),
    );
    const max = field(
      "ed-max",
      "Máximo (min)",
      h("input", { type: "text", inputmode: "decimal", value: d.max, autocomplete: "off", oninput: (e) => (d.max = e.target.value) }),
    );
    const timeHelp = h(
      "p",
      { class: "field-help" },
      "Tiempo por clip. Si el clip cabe entero, se repite completo; si no, se corta dentro del rango. Mínimo 10 s (0,17 min).",
    );

    const fitInput = h("input", { type: "checkbox", id: "ed-fit", role: "switch", checked: d.fit, onchange: (e) => (d.fit = e.target.checked) });
    const fit = h(
      "div",
      { class: "field field-inline" },
      h("label", { for: "ed-fit", class: "check-switch" }, fitInput, h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-knob" })), h("span", null, "Ajustar a pantalla")),
      h("p", { class: "field-help" }, "Fill/Fit según proporción y escala al 100 % antes de cada clip."),
    );

    const summary = h("p", { class: "form-error", role: "alert", hidden: true, tabindex: "-1" });

    const form = h(
      "form",
      {
        class: "editor card",
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          save();
        },
      },
      h("h2", { class: "section-title" }, d.isNew ? "Nueva automatización" : "Editar automatización"),
      name.wrap,
      deck.wrap,
      layer.wrap,
      clipsSet,
      orderSet,
      h("div", { class: "field-pair" }, min.wrap, max.wrap),
      timeHelp,
      fit,
      summary,
      h(
        "div",
        { class: "editor-actions" },
        h("button", { type: "button", class: "btn", onclick: closeEditor }, "Cancelar"),
        h("button", { type: "submit", class: "btn btn-primary", "data-save": "" }, icon("check"), h("span", null, "Guardar")),
      ),
    );

    editor = { form, picker, deckNote, name, min, max, summary, pickerSig: null };
    el.replaceChildren(form);
    renderPicker();
    updateDeckNote();
  }

  function updateDeckNote() {
    if (!editor) return;
    const open = S.state?.composition?.decks.find((x) => x.selected)?.name || "";
    const want = draft.deckName.trim();
    const show = want && open && want !== open;
    editor.deckNote.hidden = !show;
    editor.deckNote.textContent = show
      ? `Los clips de abajo son de la pestaña abierta («${open}»). Para elegir clips de «${want}», ábrela primero en Clips.`
      : "";
  }

  function pickerSignature() {
    const comp = S.state?.composition;
    const layer = comp?.layers.find((l) => l.index === draft.layer);
    return JSON.stringify([
      comp?.decks.find((x) => x.selected)?.name || "",
      layer ? layer.clips.filter((c) => c.state !== "empty").map((c) => [c.id, c.name, c.column]) : null,
    ]);
  }

  function renderPicker() {
    if (!editor) return;
    editor.pickerSig = pickerSignature();
    const comp = S.state?.composition;
    const layer = comp?.layers.find((l) => l.index === draft.layer);
    const avail = layer ? layer.clips.filter((c) => c.state !== "empty").sort((a, b) => a.column - b.column) : [];
    const availById = new Map(avail.map((c) => [c.id, c]));
    const selIds = new Set(draft.clips.map((c) => c.clipId));
    const rows = [
      ...draft.clips.map((c, i) => ({ ...c, selected: true, order: i, missing: !availById.has(c.clipId), durationS: availById.get(c.clipId)?.durationS })),
      ...avail.filter((c) => !selIds.has(c.id)).map((c) => ({ clipId: c.id, column: c.column, name: c.name, selected: false, durationS: c.durationS })),
    ];
    const n = draft.clips.length;
    const toAttach = [];
    const items = rows.map((r) => {
      const thumb = h(
        "div",
        { class: "thumb thumb-sm" },
        h("img", { alt: "", decoding: "async" }),
        h("span", { class: "thumb-fallback mono", "aria-hidden": "true" }, `C${r.column}`),
      );
      if (!r.missing) toAttach.push([thumb, r]);
      const cbId = `pick-${r.clipId}`;
      const meta = [`C${r.column}`];
      if (r.durationS) meta.push(mmss(r.durationS));
      return h(
        "div",
        { class: `pick-row ${r.selected ? "is-selected" : ""} ${r.missing ? "is-missing" : ""}`, role: "listitem" },
        h("input", {
          type: "checkbox",
          id: cbId,
          checked: r.selected,
          dataset: { key: cbId },
          onchange: (e) => toggleClip(r, e.target.checked),
        }),
        h(
          "label",
          { for: cbId, class: "pick-label" },
          thumb,
          h(
            "span",
            { class: "pick-text" },
            h("span", { class: "pick-name" }, r.name || `Clip ${r.column}`),
            h("span", { class: "pick-meta mono muted" }, meta.join(" · "), r.missing ? h("span", { class: "warn-text" }, " · no está en la pestaña abierta") : null),
          ),
        ),
        r.selected
          ? h(
              "span",
              { class: "pick-order" },
              h("span", { class: "pick-num mono" }, h("span", { class: "sr-only" }, "Posición "), String(r.order + 1)),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-icon btn-ghost",
                  "aria-label": `Subir ${r.name}`,
                  disabled: r.order === 0,
                  dataset: { key: `up-${r.clipId}` },
                  onclick: () => move(r.order, -1),
                },
                icon("up"),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-icon btn-ghost",
                  "aria-label": `Bajar ${r.name}`,
                  disabled: r.order === n - 1,
                  dataset: { key: `down-${r.clipId}` },
                  onclick: () => move(r.order, 1),
                },
                icon("down"),
              ),
            )
          : null,
      );
    });
    const head = h(
      "p",
      { class: "picker-head", "aria-live": "polite" },
      n ? `${n} ${n === 1 ? "clip elegido" : "clips elegidos"}, en este orden` : "Ninguno marcado: se usan todos los de la capa",
      n ? h("button", { type: "button", class: "link-btn", onclick: () => ((draft.clips = []), renderPicker()) }, "Quitar todos") : null,
    );
    replaceKeepFocus(
      editor.picker,
      head,
      items.length ? h("div", { class: "pick-list", role: "list" }, items) : h("p", { class: "muted small" }, comp ? "Esta capa no tiene clips en la pestaña abierta." : "Sin datos de Resolume."),
    );
    for (const [thumb, r] of toAttach) thumbs.attach(thumb, r.clipId, r.name);
  }

  function toggleClip(r, checked) {
    if (checked) draft.clips.push({ clipId: r.clipId, column: r.column, name: r.name });
    else draft.clips = draft.clips.filter((c) => c.clipId !== r.clipId);
    renderPicker();
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= draft.clips.length) return;
    const list = draft.clips;
    [list[i], list[j]] = [list[j], list[i]];
    renderPicker();
  }

  function setError(f, text) {
    f.err.textContent = text || "";
    f.err.hidden = !text;
    if (text) f.input.setAttribute("aria-invalid", "true");
    else f.input.removeAttribute("aria-invalid");
  }

  async function save() {
    const d = draft;
    const { name, min, max, summary } = editor;
    const errors = [];
    const nm = d.name.trim();
    setError(name, nm ? "" : "Ponle un nombre.");
    if (!nm) errors.push(name);

    const minM = parseMinutes(d.min);
    const maxM = parseMinutes(d.max);
    const minS = Math.round(minM * 60);
    const maxS = Math.round(maxM * 60);
    let minErr = "";
    let maxErr = "";
    if (!Number.isFinite(minM)) minErr = "Escribe un número (ej. 1,5).";
    else if (minS < MIN_SECONDS) minErr = "Mínimo 10 s (0,17 min).";
    if (!Number.isFinite(maxM)) maxErr = "Escribe un número (ej. 3).";
    else if (!minErr && maxS < minS) maxErr = "El máximo no puede ser menor que el mínimo.";
    setError(min, minErr);
    setError(max, maxErr);
    if (minErr) errors.push(min);
    if (maxErr) errors.push(max);

    if (errors.length) {
      summary.textContent = "Revisa los campos marcados.";
      summary.hidden = false;
      errors[0].input.focus();
      return;
    }
    summary.hidden = true;

    const btn = editor.form.querySelector("[data-save]");
    btn.disabled = true;
    const automation = {
      id: d.id,
      name: nm,
      deckName: d.deckName.trim(),
      layer: d.layer,
      clips: d.clips.map((c) => ({ clipId: c.clipId, column: c.column, name: c.name })),
      minSeconds: minS,
      maxSeconds: maxS,
      order: d.order,
      fit: d.fit,
    };
    const r = await cmd({ action: "saveAutomation", automation });
    if (!editor) return;
    btn.disabled = false;
    if (r.ok) {
      toast("Automatización guardada", "ok");
      closeEditor();
    }
  }

  function update() {
    if (draft && editor) {
      if (pickerSignature() !== editor.pickerSig) renderPicker();
      updateDeckNote();
      return;
    }
    renderList();
  }

  /** Al salir del evento o perder el rol se descarta el borrador. */
  function reset() {
    draft = null;
    editor = null;
  }

  renderList();
  return { el, update, reset };
}
