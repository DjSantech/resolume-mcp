// Panel Resolume: arranque, sesión, conexión y navegación entre pantallas.

import { S, emit, on } from "./js/store.js";
import { Connection, tokenExpired } from "./js/conn.js";
import { setConnection, thumbs } from "./js/api.js";
import { toast } from "./js/ui.js";
import { store } from "./js/util.js";
import { renderLogin } from "./js/views/login.js";
import { createEventsView } from "./js/views/events.js";
import { createEventView } from "./js/views/event.js";
import { get, loadConfig, setRestToken, setUnauthorizedHandler } from "./js/rest.js";
import { renderAccountLogin, renderInvite, renderSignup } from "./js/views/auth.js";
import { createAccountView, loadPlans, planWaLink } from "./js/views/account.js";
import { h, icon } from "./js/util.js";

const MAX_LOGS = 300;
let APP_TITLE = "Panel Resolume";

const view = document.getElementById("view");
const connBanner = document.getElementById("conn-banner");
const planBanner = document.getElementById("plan-banner");
const isAccounts = () => S.cfg.mode === "accounts";
let accountView = null;
let meTimer = null;

/** @type {Connection | null} */
let conn = null;
let eventsView = null;
let eventView = null;
let autoDone = false;
let lastSub = "";
let connTimer = null;

// ---------------------------------------------------------------- Sesión

async function boot() {
  S.cfg = await loadConfig();
  if (isAccounts()) return bootAccounts();
  // Una recarga deja el historial apuntando a un evento: empezar desde la lista.
  if (history.state?.ev) history.replaceState(null, "", location.pathname + location.search);
  const token = store.get("rp.token");
  if (token && !tokenExpired(token)) {
    S.auth = { token, role: store.get("rp.role") === "admin" ? "admin" : "viewer", name: store.get("rp.name") || "" };
    startSession();
  } else {
    showLogin();
  }
}

function showLogin(message) {
  S.route = "login";
  document.title = APP_TITLE;
  setConnBanner(null);
  if (isAccounts()) return showAuthScreen(message);
  renderLogin(view, { onLoggedIn, message });
}

function onLoggedIn(auth) {
  S.auth = auth;
  store.set("rp.token", auth.token);
  store.set("rp.role", auth.role);
  store.set("rp.name", auth.name);
  startSession();
}

function startSession() {
  S.events = [];
  S.eventsLoaded = false;
  autoDone = false;
  showEvents();
  conn = new Connection({
    token: S.auth.token,
    onMessage,
    onStatus,
    onOpen: () => {
      lastSub = "";
      subscribe();
    },
    onAuthFail: () => logout("Tu sesión venció o ya no es válida. Ingresa de nuevo."),
  });
  setConnection(conn);
  conn.start();
}

function logout(message) {
  conn?.stop();
  conn = null;
  setConnection(null);
  store.remove("rp.token");
  store.remove("rp.role");
  closeEvent();
  accountView?.destroy();
  accountView = null;
  S.account = null;
  setRestToken(null);
  clearInterval(meTimer);
  updatePlanBanner();
  if (history.state?.acct) history.replaceState(null, "", location.pathname + location.search);
  S.auth = null;
  S.events = [];
  eventsView = null;
  if (history.state?.ev) history.replaceState(null, "", location.pathname + location.search);
  showLogin(message);
}

// ---------------------------------------------------------------- Mensajes

function onMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "welcome": {
      const roleChanged = S.auth && S.auth.role !== msg.role;
      S.auth = { ...S.auth, role: msg.role === "admin" ? "admin" : "viewer", name: msg.name || S.auth?.name || "" };
      store.set("rp.role", S.auth.role);
      store.set("rp.name", S.auth.name);
      if (roleChanged) rerender();
      else eventsView?.update();
      break;
    }
    case "events":
      S.events = Array.isArray(msg.events) ? msg.events : [];
      S.eventsLoaded = true;
      if (S.route === "events") {
        eventsView?.update();
        maybeAutoEnter();
      } else if (S.route === "event") eventView?.update("events");
      emit("events");
      break;
    case "state":
      if (msg.eventId !== S.eventId || !msg.state) return;
      S.state = msg.state;
      S.stateClock.observe(msg.state.updatedAt);
      eventView?.update("state");
      break;
    case "snapshot":
      if (msg.eventId !== S.eventId || typeof msg.data !== "string") return;
      S.snapshot = { url: `data:${msg.mime || "image/jpeg"};base64,${msg.data}`, at: msg.at };
      S.snapClock.observe(msg.at);
      eventView?.onSnapshot();
      break;
    case "logs":
      if (msg.eventId !== S.eventId) return;
      S.logs = (Array.isArray(msg.entries) ? [...msg.entries] : []).sort((a, b) => b.at - a.at).slice(0, MAX_LOGS);
      eventView?.update("logs");
      break;
    case "log":
      if (msg.eventId !== S.eventId || !msg.entry) return;
      S.logs.unshift(msg.entry);
      if (S.logs.length > MAX_LOGS) S.logs.length = MAX_LOGS;
      eventView?.onLog(msg.entry);
      break;
    case "error":
      toast(msg.message || "Error del servidor", "error", 5000);
      break;
  }
}

function onStatus(status) {
  S.conn = status;
  clearTimeout(connTimer);
  if (status === "open") setConnBanner(null);
  else if (status === "reconnecting") setConnBanner("Sin conexión con el servidor. Reconectando…");
  else if (status === "connecting") connTimer = setTimeout(() => S.conn === "connecting" && setConnBanner("Conectando…"), 1200);
  emit("conn");
}

function setConnBanner(text) {
  connBanner.hidden = !text;
  connBanner.textContent = text || "";
}

// ---------------------------------------------------------------- Suscripción

/** Las capturas ya no llegan solas: se piden con el botón Refrescar (getSnapshot) para ahorrar datos. */
function subscribe() {
  const eventId = S.route === "event" ? S.eventId : null;
  const snapshots = false;
  const key = `${eventId}|${snapshots}`;
  if (key === lastSub) return;
  if (conn?.send({ type: "subscribe", eventId, snapshots })) lastSub = key;
}

on("tab", subscribe);
on("control", () => eventView?.onControl());

document.addEventListener("visibilitychange", () => {
  subscribe();
  if (document.visibilityState === "visible") conn?.nudge();
});
window.addEventListener("online", () => conn?.nudge());

// ---------------------------------------------------------------- Navegación

function showEvents() {
  S.route = "events";
  document.title = APP_TITLE;
  eventsView = createEventsView(view, {
    onOpen: (id) => openEvent(id),
    onLogout: () => logout(),
    onAccount: (sec) => openAccount(sec),
    onPair: () => openAccount("pcs", { pair: true }),
  });
}

function maybeAutoEnter() {
  if (autoDone || S.route !== "events" || isAccounts()) return;
  const last = store.get("rp.lastEvent");
  const lastEv = S.events.find((e) => e.eventId === last);
  const online = S.events.filter((e) => e.online);
  let target = null;
  if (lastEv?.online) target = lastEv.eventId;
  else if (online.length === 1) target = online[0].eventId;
  if (!target) return;
  autoDone = true;
  openEvent(target);
}

function openEvent(id, { push = true } = {}) {
  if (!S.auth) return;
  if (S.eventId !== id) resetEventData();
  S.eventId = id;
  S.control = false; // el interruptor siempre empieza apagado
  S.tab = "live";
  S.route = "event";
  store.set("rp.lastEvent", id);
  thumbs.setScope(id);
  eventView?.destroy();
  eventView = createEventView(view, { onBack: goBack, onLogout: () => logout() });
  const name = S.events.find((e) => e.eventId === id)?.name || id;
  document.title = `${name} · ${APP_TITLE}`;
  if (push) {
    const url = `#${encodeURIComponent(id)}`;
    if (history.state?.ev === id) history.replaceState({ ev: id }, "", url);
    else history.pushState({ ev: id }, "", url);
  }
  window.scrollTo({ top: 0 });
  subscribe();
}

function resetEventData() {
  S.state = null;
  S.logs = [];
  S.snapshot = null;
  S.stateClock.reset();
  S.snapClock.reset();
}

function closeEvent() {
  eventView?.destroy();
  eventView = null;
  S.eventId = null;
  S.control = false;
  resetEventData();
}

function leaveEvent() {
  autoDone = true; // volvió a mano: no reentrar solo
  closeEvent();
  showEvents();
  subscribe();
}

function goBack() {
  if (history.state?.ev) history.back();
  else leaveEvent();
}

window.addEventListener("popstate", () => {
  if (!S.auth) return;
  const acct = history.state?.acct;
  if (acct) return openAccount(acct, { push: false });
  if (S.route === "account") return closeAccount();
  const ev = history.state?.ev;
  if (S.route === "event" && !ev) leaveEvent();
  else if (ev && ev !== S.eventId) openEvent(ev, { push: false });
});

/** Rehace la pantalla actual (p. ej. si el rol cambió). */
function rerender() {
  if (S.route === "event" && S.eventId) {
    eventView?.destroy();
    const tab = S.tab;
    eventView = createEventView(view, { onBack: goBack, onLogout: () => logout() });
    if (tab !== S.tab) emit("tab");
  } else if (S.route === "events") showEvents();
}

// ---------------------------------------------------------------- Modo cuentas

async function bootAccounts() {
  APP_TITLE = S.cfg.brand || "VisualMaping";
  document.title = APP_TITLE;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", APP_TITLE);
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", "/app.webmanifest");
  setUnauthorizedHandler(() => logout("Tu sesión venció o ya no es válida. Ingresa de nuevo."));
  loadPlans();
  if (history.state?.ev || history.state?.acct) history.replaceState(null, "", location.pathname + location.search);
  window.addEventListener("hashchange", () => {
    if (!S.auth) showAuthScreen();
    else if (inviteCode()) logout(); // con sesión abierta, la invitación es para otra cuenta
  });
  const token = store.get("rp.token");
  if (!inviteCode() && token && !tokenExpired(token)) {
    setRestToken(token);
    try {
      const me = await get("/api/me", { quiet: true });
      return enterAccount(token, me);
    } catch (ex) {
      if (ex.status && ex.status !== 401) return showAuthScreen(ex.message);
      setRestToken(null);
      store.remove("rp.token");
    }
  }
  showAuthScreen();
}

function inviteCode() {
  const m = /^#invitacion-(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function showAuthScreen(message) {
  S.route = "login";
  document.title = APP_TITLE;
  setConnBanner(null);
  const done = (r, o) => onAccountLoggedIn(r, o);
  const code = inviteCode();
  if (code) renderInvite(view, code, { onLoggedIn: done });
  else if (location.hash === "#registro") renderSignup(view, { onLoggedIn: done });
  else renderAccountLogin(view, { onLoggedIn: done, message });
}

function onAccountLoggedIn(r, { welcome = false } = {}) {
  if (!r || typeof r.token !== "string" || !r.me) return showAuthScreen("Respuesta inesperada del servidor.");
  history.replaceState(null, "", location.pathname + location.search);
  enterAccount(r.token, r.me);
  if (welcome) toast(`Bienvenido a ${APP_TITLE}`, "ok", 4000);
}

/** Rol hacia el WebSocket: observador si el rol lo es o el plan venció. */
function wsRole(me) {
  return me.role !== "viewer" && me.plan?.active !== false ? "admin" : "viewer";
}

function enterAccount(token, me) {
  setRestToken(token);
  store.set("rp.token", token);
  S.account = { me };
  S.auth = { token, role: wsRole(me), name: me.user?.name || "" };
  store.set("rp.role", S.auth.role);
  store.set("rp.name", S.auth.name);
  updatePlanBanner();
  clearInterval(meTimer);
  meTimer = setInterval(refreshMe, 5 * 60e3);
  startSession();
}

async function refreshMe() {
  if (!S.account) return;
  try {
    const me = await get("/api/me", { quiet: true });
    if (!S.account) return;
    const prev = S.account.me;
    S.account = { me };
    S.auth = { ...S.auth, name: me.user?.name || S.auth.name };
    updatePlanBanner();
    const changed = prev.plan?.active !== me.plan?.active || prev.role !== me.role || prev.org?.name !== me.org?.name;
    if (changed && S.route === "events") showEvents();
  } catch {
    /* un 401 ya lleva al ingreso */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.account) refreshMe();
});

function updatePlanBanner() {
  const me = S.account?.me;
  const plan = me?.plan;
  let content = null;
  if (plan && plan.active === false) {
    planBanner.className = "plan-banner is-expired";
    content = [
      icon("power"),
      h("span", { class: "plan-banner-text" }, h("strong", null, "Tu plan venció."), " Puedes mirar, pero no controlar. Tus PCs y automatizaciones siguen funcionando."),
      S.cfg.contactWhatsapp && me.role === "owner"
        ? h("a", { class: "btn btn-sm btn-wa", href: planWaLink(null), target: "_blank", rel: "noopener" }, "Renovar")
        : h("button", { type: "button", class: "btn btn-sm", onclick: () => openAccount("plan") }, "Ver plan"),
    ];
  } else if (plan && Number.isFinite(plan.daysLeft) && plan.daysLeft <= 5) {
    planBanner.className = "plan-banner is-soon";
    const d = Math.max(0, Math.floor(plan.daysLeft));
    content = [
      h("span", { class: "plan-banner-text" }, d === 0 ? `Tu plan ${plan.name} vence hoy.` : `Te quedan ${d} ${d === 1 ? "día" : "días"} de ${plan.name}.`),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => openAccount("plan") }, "Ver planes"),
    ];
  }
  planBanner.hidden = !content;
  planBanner.replaceChildren(...(content || []));
}

function openAccount(section = "pcs", { push = true, pair = false } = {}) {
  if (!S.account) return;
  if (S.route === "event") closeEvent();
  if (S.route === "account" && accountView) {
    accountView.show(section);
  } else {
    S.route = "account";
    eventsView = null;
    accountView = createAccountView(view, {
      section,
      onBack: () => (history.state?.acct ? history.back() : closeAccount()),
      onLogout: () => logout(),
      onSection: (id) => openAccount(id),
      refreshMe,
      onPasswordChanged: (r) => {
        if (r?.token) {
          toast("Contraseña cambiada", "ok");
          conn?.stop();
          enterAccount(r.token, r.me || S.account.me);
        } else logout("Contraseña cambiada. Entra con la nueva contraseña.");
      },
    });
  }
  document.title = `Cuenta · ${APP_TITLE}`;
  if (push) {
    const url = location.pathname + location.search;
    if (history.state?.acct) history.replaceState({ acct: section }, "", url);
    else history.pushState({ acct: section }, "", url);
  }
  window.scrollTo({ top: 0 });
  subscribe();
  if (pair) setTimeout(() => document.querySelector(".acct-head .btn-arm:not(:disabled)")?.click(), 400);
}

function closeAccount() {
  accountView?.destroy();
  accountView = null;
  showEvents();
  subscribe();
}

boot();
