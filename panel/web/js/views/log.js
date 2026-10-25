// Pestaña Registro: últimos eventos del log, más nuevo primero.

import { S } from "../store.js";
import { dateTime, h } from "../util.js";

const LEVEL = { info: "Info", warn: "Aviso", error: "Error" };

export function createLogTab() {
  const list = h("ol", { class: "log-list", "aria-label": "Registro, más reciente primero" });
  const empty = h("p", { class: "empty" }, "Sin movimientos todavía.");
  const el = h("div", { class: "log" }, h("h2", { class: "section-title" }, "Registro"), empty, list);

  /** @param {import("../store.js").LogEntry} e */
  function row(e) {
    return h(
      "li",
      { class: `log-row log-${e.level}` },
      h("time", { class: "log-time mono", datetime: new Date(e.at).toISOString() }, dateTime(e.at)),
      h("span", { class: "log-level" }, LEVEL[e.level] || e.level),
      h("span", { class: "log-by" }, e.by),
      h("span", { class: "log-text" }, e.text),
    );
  }

  function update() {
    list.replaceChildren(...S.logs.map(row));
    empty.hidden = S.logs.length > 0;
  }

  function prepend(entry) {
    list.prepend(row(entry));
    while (list.children.length > S.logs.length) list.lastElementChild.remove();
    empty.hidden = true;
  }

  update();
  return { el, update, prepend };
}
