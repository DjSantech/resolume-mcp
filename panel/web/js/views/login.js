// Pantalla de ingreso: nombre + código.

import { login } from "../conn.js";
import { h, store } from "../util.js";

/**
 * @param {HTMLElement} root
 * @param {{ onLoggedIn: (auth: {token:string, role:string, name:string}) => void, message?: string }} opts
 */
export function renderLogin(root, { onLoggedIn, message }) {
  const nameInput = h("input", {
    id: "login-name",
    name: "name",
    type: "text",
    required: true,
    maxlength: "40",
    autocomplete: "nickname",
    autocapitalize: "words",
    spellcheck: "false",
    value: store.get("rp.lastName") || "",
  });
  const codeInput = h("input", {
    id: "login-code",
    name: "code",
    type: "password",
    required: true,
    autocomplete: "current-password",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const err = h("p", { class: "form-error", role: "alert", hidden: !message }, message || "");
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, "Entrar");

  const form = h(
    "form",
    {
      class: "login-form card",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        const code = codeInput.value;
        if (!name) return showError("Escribe tu nombre (se ve en el registro).", nameInput);
        if (!code) return showError("Escribe el código de acceso.", codeInput);
        submit.disabled = true;
        submit.textContent = "Entrando…";
        err.hidden = true;
        try {
          const auth = await login(name, code);
          store.set("rp.lastName", name);
          onLoggedIn(auth);
        } catch (ex) {
          showError(ex.message, codeInput);
          codeInput.select();
        } finally {
          submit.disabled = false;
          submit.textContent = "Entrar";
        }
      },
    },
    h("div", { class: "field" }, h("label", { for: "login-name" }, "Tu nombre"), nameInput),
    h("div", { class: "field" }, h("label", { for: "login-code" }, "Código de acceso"), codeInput),
    err,
    submit,
  );

  function showError(text, focusEl) {
    err.textContent = text;
    err.hidden = false;
    focusEl?.focus();
  }

  root.replaceChildren(
    h(
      "div",
      { class: "login wrap" },
      h(
        "header",
        { class: "brand" },
        h("span", { class: "brand-lamp", "aria-hidden": "true" }),
        h("h1", { class: "brand-title" }, "Panel", h("span", null, "Resolume")),
        h("p", { class: "brand-sub" }, "Ver y controlar la salida en vivo"),
      ),
      form,
    ),
  );
  (nameInput.value ? codeInput : nameInput).focus();
}
