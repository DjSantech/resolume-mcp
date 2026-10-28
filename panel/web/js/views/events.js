// Lista de eventos: tarjetas con estado del puente, Resolume, qué suena y automatización.

import { S } from "../store.js";
import { ago, h, icon, replaceKeepFocus } from "../util.js";
import { ROLE_LABEL } from "../rest.js";

/**
 * @param {HTMLElement} root
 * @param {{ onOpen: (eventId: string) => void, onLogout: () => void }} opts
 */
export function createEventsView(root, { onOpen, onLogout, onAccount, onPair }) {
  const accounts = S.cfg?.mode === "accounts";
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
          accounts
            ? h("div", { class: "ev-titles" }, h("h1", { class: "ev-title" }, "Tus PCs"), h("p", { class: "ev-sub muted small" }, S.account?.me?.org?.name || ""))
            : h("h1", { class: "topbar-title" }, "Eventos"),
          who,
          accounts
            ? h("button", { type: "button", class: "btn btn-sm acct-btn", onclick: () => onAccount?.("pcs") }, icon("user"), h("span", null, "Cuenta"))
            : h(
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
    const acctRole = S.account?.me?.role;
    who.replaceChildren(
      accounts ? "" : h("span", null, S.auth?.name || ""),
      h("span", { class: `role-chip ${S.auth?.role === "admin" ? "is-admin" : ""}` }, accounts && acctRole && S.auth?.role === "admin" ? ROLE_LABEL[acctRole] : S.auth?.role === "admin" ? "control" : "observador"),
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
          h("p", null, h("strong", null, accounts ? "Aún no tienes PCs vinculados." : "No hay eventos conectados.")),
          h("p", { class: "muted" }, accounts ? "Instala el agente en el PC de Resolume y vincúlalo con un código." : "Arranca el puente en el PC del evento y aparecerá aquí."),
          accounts && S.account?.me?.role !== "viewer"
            ? h("button", { type: "button", class: "btn btn-arm empty-cta", onclick: () => onPair?.() }, icon("plus"), "Vincular un PC")
            : null,
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
      : h("span", { class: "status status-off" }, h("span", { class: "dot" }), ev.lastSeen ? `Fuera de línea · ${ago(Date.now() - ev.lastSeen)}` : "Nunca se ha conectado");
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
