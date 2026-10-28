// Modo cuentas: registro de empresa, ingreso con correo y aceptar una invitación.

import { S } from "../store.js";
import { get, post, ROLE_HELP, ROLE_LABEL, shortDate } from "../rest.js";
import { h, store } from "../util.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Encabezado con la marca (del servidor). */
function brandHeader(sub) {
  return h(
    "header",
    { class: "brand" },
    h("span", { class: "brand-lamp", "aria-hidden": "true" }),
    h("h1", { class: "brand-title brand-title-one" }, S.cfg?.brand || "VisualMaping"),
    h("p", { class: "brand-sub" }, sub),
  );
}

let fieldSeq = 0;

/** Campo con etiqueta, ayuda opcional y error propio. */
function field(label, attrs, help) {
  const id = `f-${++fieldSeq}`;
  const input = h("input", { id, ...attrs });
  const helpEl = help ? h("p", { class: "field-help", id: `${id}-help` }, help) : null;
  if (helpEl) input.setAttribute("aria-describedby", helpEl.id);
  return { input, el: h("div", { class: "field" }, h("label", { for: id }, label), input, helpEl) };
}

/** Formulario con error y botón que se bloquea mientras espera. */
function authForm({ fields, submitText, busyText, onSubmit, after }) {
  const err = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, submitText);
  const form = h(
    "form",
    {
      class: "login-form card",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        for (const f of fields) f.input.removeAttribute("aria-invalid");
        submit.disabled = true;
        submit.textContent = busyText;
        try {
          await onSubmit(showError);
        } finally {
          submit.disabled = false;
          submit.textContent = submitText;
        }
      },
    },
    fields.map((f) => f.el),
    err,
    submit,
    after,
  );
  function showError(text, input) {
    err.textContent = text;
    err.hidden = false;
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  }
  return form;
}

function emailField(value = "") {
  return field("Correo", { type: "email", name: "email", required: true, autocomplete: "email", autocapitalize: "off", spellcheck: "false", inputmode: "email", maxlength: "120", value });
}

function checkEmail(f, showError) {
  const v = f.input.value.trim().toLowerCase();
  if (!EMAIL_RE.test(v)) {
    showError("Escribe un correo válido.", f.input);
    return null;
  }
  return v;
}

function switchLink(text, linkText, hash) {
  return h("p", { class: "auth-switch" }, text, " ", h("a", { href: hash, class: "auth-link" }, linkText));
}

function screen(root, sub, form, extra) {
  root.replaceChildren(
    h("div", { class: "login wrap" }, brandHeader(sub), form, extra, h("p", { class: "auth-foot" }, h("a", { href: "/", class: "auth-link muted" }, "Conoce el servicio"))),
  );
}

/**
 * Ingreso con correo y contraseña.
 * @param {{ onLoggedIn: (r: {token:string, me:any}) => void, message?: string }} opts
 */
export function renderAccountLogin(root, { onLoggedIn, message }) {
  const email = emailField(store.get("rp.lastEmail") || "");
  const pass = field("Contraseña", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const form = authForm({
    fields: [email, pass],
    submitText: "Entrar",
    busyText: "Entrando…",
    after: switchLink("¿Tu empresa aún no tiene cuenta?", "Crea una gratis", "#registro"),
    async onSubmit(showError) {
      const e = checkEmail(email, showError);
      if (!e) return;
      if (!pass.input.value) return showError("Escribe tu contraseña.", pass.input);
      try {
        const r = await post("/api/login", { email: e, password: pass.input.value }, { quiet: true, auth: false });
        store.set("rp.lastEmail", e);
        onLoggedIn(r);
      } catch (ex) {
        showError(ex.message, pass.input);
        pass.input.select();
      }
    },
  });
  screen(root, "Entra a tu cuenta", form);
  if (message) {
    const err = form.querySelector(".form-error");
    err.textContent = message;
    err.hidden = false;
  }
  (email.input.value ? pass.input : email.input).focus();
}

/** Registro de empresa nueva (plan de prueba). */
export function renderSignup(root, { onLoggedIn }) {
  const org = field("Empresa o nombre artístico", { type: "text", name: "organization", required: true, maxlength: "60", autocomplete: "organization", autocapitalize: "words" });
  const name = field("Tu nombre", { type: "text", name: "name", required: true, maxlength: "40", autocomplete: "name", autocapitalize: "words" });
  const email = emailField();
  const pass = field("Contraseña", { type: "password", name: "new-password", required: true, minlength: "8", autocomplete: "new-password" }, "Mínimo 8 caracteres.");
  const trial = (S.plans || []).find((p) => p.trialDays);
  const days = trial?.trialDays || 14;
  const form = authForm({
    fields: [org, name, email, pass],
    submitText: "Crear cuenta gratis",
    busyText: "Creando…",
    after: [
      h("p", { class: "auth-note" }, `${days} días de prueba con 1 PC. Sin tarjeta.`),
      switchLink("¿Ya tienes cuenta?", "Entra aquí", "#entrar"),
    ],
    async onSubmit(showError) {
      const orgName = org.input.value.trim();
      const n = name.input.value.trim();
      if (orgName.length < 2) return showError("Escribe el nombre de tu empresa.", org.input);
      if (!n) return showError("Escribe tu nombre.", name.input);
      const e = checkEmail(email, showError);
      if (!e) return;
      if (pass.input.value.length < 8) return showError("La contraseña debe tener al menos 8 caracteres.", pass.input);
      try {
        const r = await post("/api/signup", { orgName, name: n, email: e, password: pass.input.value }, { quiet: true, auth: false });
        store.set("rp.lastEmail", e);
        onLoggedIn(r, { welcome: true });
      } catch (ex) {
        showError(ex.message, ex.status === 409 ? email.input : null);
      }
    },
  });
  screen(root, "Crea la cuenta de tu empresa", form);
  org.input.focus();
}

/** Invitación: muestra a qué empresa y con qué rol, y pide los datos para unirse. */
export async function renderInvite(root, code, { onLoggedIn }) {
  root.replaceChildren(h("div", { class: "login wrap" }, brandHeader("Invitación"), h("p", { class: "empty" }, "Revisando la invitación…")));
  let inv;
  try {
    inv = await get(`/api/invites/${encodeURIComponent(code)}`, { quiet: true, auth: false });
  } catch (ex) {
    const gone = ex.status === 404 || ex.status === 410;
    root.replaceChildren(
      h(
        "div",
        { class: "login wrap" },
        brandHeader("Invitación"),
        h(
          "div",
          { class: "card auth-msg" },
          h("h2", { class: "auth-msg-title" }, gone ? "Esta invitación ya no sirve" : "No se pudo revisar la invitación"),
          h("p", { class: "muted" }, gone ? "Venció, ya se usó o fue anulada. Pídele al dueño de la cuenta que te mande una nueva." : ex.message),
          h("a", { href: "#entrar", class: "btn btn-block" }, "Ir a entrar"),
        ),
      ),
    );
    return;
  }
  const role = inv.role in ROLE_LABEL ? inv.role : "viewer";
  const name = field("Tu nombre", { type: "text", name: "name", required: true, maxlength: "40", autocomplete: "name", autocapitalize: "words" });
  const email = emailField();
  const pass = field("Contraseña", { type: "password", name: "password", required: true, minlength: "8", autocomplete: "new-password" }, "Si ya tienes cuenta, usa tu contraseña de siempre.");
  const form = authForm({
    fields: [name, email, pass],
    submitText: "Unirme al equipo",
    busyText: "Uniendo…",
    async onSubmit(showError) {
      const n = name.input.value.trim();
      if (!n) return showError("Escribe tu nombre.", name.input);
      const e = checkEmail(email, showError);
      if (!e) return;
      if (pass.input.value.length < 8) return showError("La contraseña debe tener al menos 8 caracteres.", pass.input);
      try {
        const r = await post(`/api/invites/${encodeURIComponent(code)}/accept`, { name: n, email: e, password: pass.input.value }, { quiet: true, auth: false });
        store.set("rp.lastEmail", e);
        onLoggedIn(r, { welcome: true });
      } catch (ex) {
        showError(ex.message, ex.status === 401 ? pass.input : ex.status === 409 ? email.input : null);
      }
    },
  });
  const head = h(
    "div",
    { class: "card invite-head" },
    h("span", { class: "legend" }, "Te invitaron a"),
    h("p", { class: "invite-org" }, inv.orgName || "un equipo"),
    h("p", { class: "invite-role" }, h("span", { class: `role-chip ${role !== "viewer" ? "is-admin" : ""}` }, ROLE_LABEL[role]), h("span", { class: "muted small" }, ROLE_HELP[role])),
    inv.expiresAt ? h("p", { class: "muted small" }, `Vence el ${shortDate(inv.expiresAt)}`) : null,
  );
  screen(root, "Invitación", h("div", { class: "auth-stack" }, head, form));
  name.input.focus();
}
