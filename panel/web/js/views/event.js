// Vista de un evento: encabezado con estado, avisos, pestañas y barra inferior.

import { S, currentSummary, emit, isAdmin } from "../store.js";
import { tickRunners } from "../runner.js";
import { banner } from "../ui.js";
import { h, icon } from "../util.js";
import { createLiveTab } from "./live.js";
import { createClipsTab } from "./clips.js";
import { createAutosTab } from "./autos.js";
import { createLogTab } from "./log.js";

const TABS = [
  { id: "live", label: "En vivo", icon: "live" },
  { id: "clips", label: "Clips", icon: "grid" },
  { id: "autos", label: "Automático", icon: "loop" },
  { id: "log", label: "Registro", icon: "list" },
];

/**
 * @param {HTMLElement} root
 * @param {{ onBack: () => void, onLogout: () => void }} opts
 */
export function createEventView(root, { onBack, onLogout }) {
  const views = {
    live: createLiveTab(),
    clips: createClipsTab(),
    autos: createAutosTab(),
    log: createLogTab(),
  };
  const dirty = new Set();

  const title = h("h1", { class: "ev-title" });
  const sub = h("p", { class: "ev-sub" });
  const lamp = h("span", { class: "ev-lamp tally tally-idle" }, "LIBRE");
  const banners = h("div", { class: "banners wrap" });

  const panels = {};
  const tabBtns = {};
  for (const t of TABS) {
    panels[t.id] = h(
      "section",
      { class: "panel wrap", id: `panel-${t.id}`, role: "tabpanel", "aria-labelledby": `tab-${t.id}`, tabindex: "-1", hidden: true },
      views[t.id].el,
    );
    tabBtns[t.id] = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `tab-${t.id}`,
        class: "tab",
        "aria-controls": `panel-${t.id}`,
        "aria-selected": "false",
        tabindex: "-1",
        onclick: () => selectTab(t.id),
        onkeydown: onTabKey,
      },
      icon(t.icon),
      h("span", { class: "tab-label" }, t.label),
    );
  }

  const nav = h("nav", { class: "tabbar", "aria-label": "Secciones del evento" }, h("div", { class: "tabbar-inner", role: "tablist" }, TABS.map((t) => tabBtns[t.id])));

  root.replaceChildren(
    h(
      "div",
      { class: `screen event-screen ${isAdmin() ? "is-admin" : "is-viewer"}` },
      h(
        "header",
        { class: "topbar ev-head" },
        h(
          "div",
          { class: "topbar-inner wrap" },
          h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Volver a eventos", onclick: onBack }, icon("back")),
          h("div", { class: "ev-titles" }, title, sub),
          lamp,
          h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Cerrar sesión", onclick: onLogout }, icon("logout")),
        ),
      ),
      nav,
      banners,
      h("main", { class: "ev-main" }, TABS.map((t) => panels[t.id])),
    ),
  );

  function onTabKey(e) {
    const i = TABS.findIndex((t) => t.id === S.tab);
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = TABS.length - 1;
    if (j === null) return;
    e.preventDefault();
    selectTab(TABS[j].id);
    tabBtns[TABS[j].id].focus();
  }

  function selectTab(id) {
    if (!panels[id]) id = "live";
    const changed = S.tab !== id;
    S.tab = id;
    for (const t of TABS) {
      const on = t.id === id;
      panels[t.id].hidden = !on;
      tabBtns[t.id].setAttribute("aria-selected", String(on));
      tabBtns[t.id].tabIndex = on ? 0 : -1;
    }
    if (dirty.has(id)) {
      dirty.delete(id);
      views[id].update();
    }
    if (id === "live") views.live.updateSnapshot();
    if (changed) {
      window.scrollTo({ top: 0 });
      emit("tab");
    }
  }

  function updateHeader() {
    const sum = currentSummary();
    title.textContent = sum?.name || S.eventId || "";
    const st = S.state;
    const parts = [];
    if (!sum || !sum.online) parts.push(h("span", { class: "status status-off" }, h("span", { class: "dot" }), "Puente desconectado"));
    else parts.push(h("span", { class: "status status-on" }, h("span", { class: "dot" }), "En línea"));
    if (st && sum?.online) {
      parts.push(
        st.resolumeOnline
          ? h("span", { class: "status status-on" }, "Resolume")
          : h("span", { class: "status status-warn" }, "Resolume sin respuesta"),
      );
    }
    sub.replaceChildren(...parts);

    const onAir = (st?.nowPlaying || []).length > 0 && st?.resolumeOnline;
    lamp.className = `ev-lamp tally ${onAir ? "tally-air" : "tally-idle"}`;
    lamp.textContent = onAir ? "AL AIRE" : "LIBRE";

    const b = [];
    if (!sum || !sum.online)
      b.push(banner("off", "El PC del evento no está conectado. Lo que ves puede estar desactualizado.", "power"));
    else if (st && !st.resolumeOnline) b.push(banner("warn", "Resolume no responde en el PC del evento. Revisa que esté abierto y con el webserver activo.", "power"));
    banners.replaceChildren(...b);
    banners.hidden = b.length === 0;
  }

  /** Actualiza la pestaña visible y marca las demás para cuando se abran. */
  function update(topic) {
    updateHeader();
    if (topic === "events") return;
    for (const t of TABS) {
      if (topic === "logs" && t.id !== "log") continue;
      if (t.id === S.tab) views[t.id].update();
      else dirty.add(t.id);
    }
  }

  function onLog(entry) {
    if (S.tab === "log") views.log.prepend(entry);
    else dirty.add("log");
  }

  const timer = setInterval(() => {
    if (S.tab === "live") views.live.tick();
    views.clips.tick();
    tickRunners(root);
  }, 500);

  selectTab(S.tab);
  update("state");

  return {
    update,
    onLog,
    onSnapshot: () => S.tab === "live" && views.live.updateSnapshot(),
    onControl: () => views.clips.applyControl(),
    destroy() {
      clearInterval(timer);
      views.autos.reset();
    },
  };
}
