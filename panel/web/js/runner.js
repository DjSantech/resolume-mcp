// Tarjeta de la automatización en curso, con barra de progreso del clip actual.

import { S, isAdmin } from "./store.js";
import { cmd } from "./api.js";
import { h, icon, mmss } from "./util.js";

/** @param {import("./store.js").RunnerState} runner */
export function runnerCard(runner) {
  const cur = runner.current;
  const admin = isAdmin();
  let progress = null;
  if (cur) {
    const start = S.stateClock.toLocal(cur.startedAt);
    const until = S.stateClock.toLocal(cur.until);
    progress = h(
      "div",
      { class: "runner-progress" },
      h(
        "div",
        {
          class: "meter",
          role: "progressbar",
          "aria-label": "Progreso del clip actual",
          "aria-valuemin": "0",
          "aria-valuemax": "100",
          dataset: { start: String(start), until: String(until) },
        },
        h("div", { class: "meter-fill" }),
      ),
      h(
        "div",
        { class: "runner-times mono" },
        h("span", { "data-elapsed": "" }, "0:00"),
        h("span", { class: "muted" }, cur.how || ""),
        h("span", { "data-left": "" }, `−${mmss((until - start) / 1000)}`),
      ),
    );
  }

  const busy = new Set();
  const action = (name, label, iconName, command, cls) =>
    h(
      "button",
      {
        type: "button",
        class: `btn ${cls || ""}`,
        dataset: { key: `runner-${name}` },
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (busy.has(name)) return;
          busy.add(name);
          btn.setAttribute("aria-busy", "true");
          await cmd(command);
          busy.delete(name);
          btn.removeAttribute("aria-busy");
        },
      },
      icon(iconName),
      h("span", null, label),
    );

  return h(
    "section",
    { class: "runner card", "aria-label": "Automatización en curso" },
    h(
      "div",
      { class: "runner-head" },
      h("span", { class: "tally tally-auto" }, "AUTO"),
      h("strong", { class: "runner-name" }, runner.automationName),
      runner.loops > 0 ? h("span", { class: "chip mono" }, `vuelta ${runner.loops + 1}`) : null,
    ),
    h(
      "div",
      { class: "runner-now" },
      h("span", { class: "legend" }, "Ahora"),
      h("span", { class: "runner-clip" }, cur ? cur.name : "Preparando…"),
      cur ? h("span", { class: "muted mono" }, `C${cur.column}`) : null,
    ),
    progress,
    runner.next
      ? h(
          "div",
          { class: "runner-next" },
          h("span", { class: "legend" }, "Sigue"),
          h("span", null, runner.next.name),
          h("span", { class: "muted mono" }, `C${runner.next.column}`),
        )
      : null,
    admin
      ? h(
          "div",
          { class: "runner-actions" },
          action("skip", "Saltar", "skip", { action: "skipAutomation" }, ""),
          action("stop", "Detener", "stop", { action: "stopAutomation" }, "btn-danger-outline"),
        )
      : null,
  );
}

/** Actualiza las barras de progreso visibles. */
export function tickRunners(root = document) {
  const now = Date.now();
  for (const m of root.querySelectorAll(".runner .meter[data-start]")) {
    const start = Number(m.dataset.start);
    const until = Number(m.dataset.until);
    const total = Math.max(1, until - start);
    const done = Math.min(total, Math.max(0, now - start));
    const p = (done / total) * 100;
    m.firstElementChild.style.setProperty("width", `${p.toFixed(2)}%`);
    m.setAttribute("aria-valuenow", String(Math.round(p)));
    const box = m.parentElement;
    const el = box.querySelector("[data-elapsed]");
    const left = box.querySelector("[data-left]");
    if (el) el.textContent = mmss(done / 1000);
    if (left) left.textContent = `−${mmss((total - done) / 1000)}`;
  }
}
