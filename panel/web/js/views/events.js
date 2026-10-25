// Lista de eventos: tarjetas con estado del puente, Resolume, qué suena y automatización.

import { S } from "../store.js";
import { ago, h, icon, replaceKeepFocus } from "../util.js";

/**
 * @param {HTMLElement} root
 * @param {{ onOpen: (eventId: string) => void, onLogout: () => void }} opts
 */
export function createEventsView(root, { onOpen, onLogout }) {
  const list = h("div", { class: "event-list", "aria-live": "polite" });
  const who = h("span", { class: "who" });

  root.replaceChildren(
    h(
      "div",
      { class: "screen" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "topbar-inner wrap" },
          h("h1", { class: "topbar-title" }, "Eventos"),
          who,
          h(
            "button",
            { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Cerrar sesión", onclick: onLogout },
            icon("logout"),
          ),
        ),
      ),
      h("main", { class: "wrap content" }, list),
    ),
  );

  function update() {
    who.replaceChildren(
      h("span", null, S.auth?.name || ""),
      h("span", { class: `role-chip ${S.auth?.role === "admin" ? "is-admin" : ""}` }, S.auth?.role === "admin" ? "control" : "observador"),
    );

    if (!S.eventsLoaded) {
      replaceKeepFocus(list, h("p", { class: "empty" }, "Conectando con el servidor…"));
      return;
    }
    if (!S.events.length) {
      replaceKeepFocus(
        list,
        h(
          "div",
          { class: "empty" },
          h("p", null, h("strong", null, "No hay eventos conectados.")),
          h("p", { class: "muted" }, "Arranca el puente en el PC del evento y aparecerá aquí."),
        ),
      );
      return;
    }
    const sorted = [...S.events].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "es"));
    replaceKeepFocus(list, sorted.map(card));
  }

  /** @param {import("../store.js").EventSummary} ev */
  function card(ev) {
    const live = ev.online && ev.nowPlaying.length > 0;
    const status = ev.online
      ? h("span", { class: "status status-on" }, h("span", { class: "dot" }), "En línea")
      : h("span", { class: "status status-off" }, h("span", { class: "dot" }), `Fuera de línea · ${ago(Date.now() - ev.lastSeen)}`);
    const resolume = ev.online
      ? ev.resolumeOnline
        ? h("span", { class: "status status-on" }, "Resolume conectado")
        : h("span", { class: "status status-warn" }, "Resolume sin respuesta")
      : null;

    const playing = ev.nowPlaying.length
      ? h(
          "ul",
          { class: "np-list" },
          [...ev.nowPlaying]
            .sort((a, b) => b.layer - a.layer)
            .map((np) =>
              h(
                "li",
                null,
                h("span", { class: "np-layer" }, np.layerName || `Capa ${np.layer}`),
                h("span", { class: "np-clip" }, np.name),
              ),
            ),
        )
      : h("p", { class: "muted small" }, ev.online ? "Nada al aire" : "");

    return h(
      "button",
      {
        type: "button",
        class: `event-card card ${live ? "is-live" : ""} ${ev.online ? "" : "is-offline"}`,
        dataset: { key: `ev-${ev.eventId}` },
        onclick: () => onOpen(ev.eventId),
      },
      h(
        "div",
        { class: "event-card-head" },
        h("span", { class: "event-name" }, ev.name || ev.eventId),
        live ? h("span", { class: "tally tally-air" }, "AL AIRE") : null,
      ),
      h("div", { class: "event-status" }, status, resolume),
      playing,
      ev.runner
        ? h(
            "p",
            { class: "event-runner" },
            h("span", { class: "tally tally-auto" }, "AUTO"),
            h("span", null, ev.runner.automationName, ev.runner.current ? ` · ${ev.runner.current}` : ""),
          )
        : null,
    );
  }

  update();
  return { update };
}
