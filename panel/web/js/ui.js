// Avisos breves (toasts) y confirmaciones dentro de la página.

import { h, icon } from "./util.js";

let toastBox = null;

/** kind: "info" | "error" | "ok" */
export function toast(text, kind = "info", ms = 3500) {
  toastBox ??= document.getElementById("toasts");
  if (!toastBox) return;
  // No apilar el mismo aviso repetido.
  for (const t of toastBox.children) if (t.dataset.text === text) t.remove();
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status", dataset: { text } }, text);
  toastBox.append(el);
  while (toastBox.children.length > 3) toastBox.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 250);
  }, ms);
}

let dialog = null;

/**
 * Confirmación modal accesible (sin window.confirm).
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, ok = "Confirmar", cancel = "Cancelar", danger = false }) {
  if (dialog?.open) dialog.close("cancel");
  dialog?.remove();
  return new Promise((resolve) => {
    const titleId = "dlg-title";
    const okBtn = h("button", { type: "submit", value: "ok", class: `btn ${danger ? "btn-danger" : "btn-primary"}` }, ok);
    const cancelBtn = h("button", { type: "submit", value: "cancel", class: "btn", formnovalidate: true }, cancel);
    dialog = h(
      "dialog",
      { class: "dialog", "aria-labelledby": titleId },
      h(
        "form",
        { method: "dialog", class: "dialog-form" },
        h("h2", { id: titleId, class: "dialog-title" }, title),
        body ? h("p", { class: "dialog-body" }, body) : null,
        h("div", { class: "dialog-actions" }, cancelBtn, okBtn),
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      const d = dialog;
      setTimeout(() => d.remove(), 0);
    });
    // Tocar fuera del cuadro cancela.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close("cancel");
    });
    document.body.append(dialog);
    dialog.returnValue = "cancel";
    dialog.showModal();
    // En acciones peligrosas el foco queda en Cancelar.
    (danger ? cancelBtn : okBtn).focus();
  });
}

/** Barra de aviso persistente. */
export function banner(kind, text, iconName) {
  return h("div", { class: `banner banner-${kind}`, role: "status" }, iconName ? icon(iconName) : null, h("span", null, text));
}
