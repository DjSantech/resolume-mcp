// Panel Resolume: arranque, sesión, conexión y navegación entre pantallas.

import { S, emit, on } from "./js/store.js";
import { Connection, tokenExpired } from "./js/conn.js";
import { setConnection, thumbs } from "./js/api.js";
import { toast } from "./js/ui.js";
import { store } from "./js/util.js";
import { renderLogin } from "./js/views/login.js";
import { createEventsView } from "./js/views/events.js";
import { createEventView } from "./js/views/event.js";

const MAX_LOGS = 300;
const APP_TITLE = "Panel Resolume";

const view = document.getElementById("view");
const connBanner = document.getElementById("conn-banner");

/** @type {Connection | null} */
let conn = null;
let eventsView = null;
let eventView = null;
let autoDone = false;
let lastSub = "";
let connTimer = null;

// ---------------------------------------------------------------- Sesión

function boot() {
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

/** Captura solo si la pestaña En vivo está visible y la página en primer plano. */
function subscribe() {
  const eventId = S.route === "event" ? S.eventId : null;
  const snapshots = !!eventId && S.tab === "live" && document.visibilityState === "visible";
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
  eventsView = createEventsView(view, { onOpen: (id) => openEvent(id), onLogout: () => logout() });
}

function maybeAutoEnter() {
  if (autoDone || S.route !== "events") return;
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

boot();
