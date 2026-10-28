// Modo cuentas: secciones de la cuenta (PCs, Equipo, Plan, Mi perfil, Superadmin).

import { S } from "../store.js";
import { cop, del, get, patch, post, prettyCode, ROLE_HELP, ROLE_LABEL, shortDate, toMs, waLink } from "../rest.js";
import { confirmDialog, toast } from "../ui.js";
import { ago, h, icon, mmss } from "../util.js";

export const SECTIONS = [
  { id: "pcs", label: "PCs" },
  { id: "equipo", label: "Equipo" },
  { id: "plan", label: "Plan" },
  { id: "perfil", label: "Mi perfil" },
  { id: "admin", label: "Superadmin", superadmin: true },
];

const me = () => S.account?.me;
const role = () => me()?.role || "viewer";
const isOwner = () => role() === "owner";
const canPair = () => role() === "owner" || role() === "operator";
const planActive = () => me()?.plan?.active !== false;
/** replaceChildren sin "null": descarta hijos vacíos. */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

const brand = () => S.cfg?.brand || "VisualMaping";

/** Enlace a WhatsApp de soporte con mensaje para activar un plan. */
export function planWaLink(planName) {
  const m = me();
  const who = m ? `Hola, soy ${m.user?.name || ""} de ${m.org?.name || "mi empresa"}.` : "Hola.";
  const want = planName ? ` Quiero activar el plan ${planName} de ${brand()}.` : ` Quiero renovar mi plan de ${brand()}.`;
  return waLink(S.cfg?.contactWhatsapp, who + want);
}

/** Lista de planes (cacheada en S.plans). */
export async function loadPlans() {
  if (S.plans?.length) return S.plans;
  try {
    const r = await get("/api/plans", { quiet: true, auth: false });
    S.plans = Array.isArray(r) ? r : [];
  } catch {
    S.plans = [];
  }
  return S.plans;
}

const priceText = (p) => (p.priceCop > 0 ? `${cop(p.priceCop)} / mes` : p.trialDays ? `Gratis · ${p.trialDays} días` : "Gratis");
const pcsText = (n) => (n === 1 ? "1 PC" : `${n} PCs`);

function sectionHead(title, sub, action) {
  return h("div", { class: "acct-head" }, h("div", { class: "acct-head-text" }, h("h2", { class: "acct-title" }, title), sub ? h("p", { class: "muted small" }, sub) : null), action || null);
}

function loading() {
  return h("p", { class: "empty" }, "Cargando…");
}

function loadError(msg, retry) {
  return h("div", { class: "empty" }, h("p", null, msg), h("button", { type: "button", class: "btn btn-sm", onclick: retry }, "Reintentar"));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado", "ok", 1800);
    return;
  } catch {
    /* http del hotspot o permiso negado: usar un campo temporal */
  }
  const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }, text);
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  toast(ok ? "Copiado" : "No se pudo copiar: mantén presionado el enlace para copiarlo", ok ? "ok" : "error", 2500);
}

/**
 * @param {HTMLElement} root
 * @param {{ section: string, onBack: () => void, onLogout: () => void, onSection: (id: string) => void, refreshMe: () => Promise<void>, onPasswordChanged: (r: any) => void }} opts
 */
export function createAccountView(root, opts) {
  const sections = SECTIONS.filter((s) => !s.superadmin || me()?.superadmin);
  let current = sections.some((s) => s.id === opts.section) ? opts.section : "pcs";
  const body = h("div", { class: "acct-body" });
  const tabs = {};
  /** Limpiezas de la sección visible (temporizadores). */
  let cleanups = [];

  const nav = h(
    "nav",
    { class: "acct-nav", "aria-label": "Secciones de la cuenta" },
    h(
      "div",
      { class: "acct-nav-inner wrap", role: "tablist" },
      sections.map((s) => {
        tabs[s.id] = h(
          "button",
          { type: "button", role: "tab", class: "acct-tab", id: `acct-tab-${s.id}`, "aria-controls": "acct-panel", onclick: () => opts.onSection(s.id) },
          s.label,
        );
        return tabs[s.id];
      }),
    ),
  );

  put(root, 
    h(
      "div",
      { class: "screen acct-screen" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "topbar-inner wrap" },
          h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Volver a tus PCs", onclick: opts.onBack }, icon("back")),
          h("div", { class: "ev-titles" }, h("h1", { class: "ev-title" }, "Cuenta"), h("p", { class: "ev-sub muted small" }, me()?.org?.name || "")),
          h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Cerrar sesión", onclick: opts.onLogout }, icon("logout")),
        ),
      ),
      nav,
      h("main", { class: "wrap content", id: "acct-panel", role: "tabpanel", tabindex: "-1" }, body),
    ),
  );

  function cleanup() {
    for (const fn of cleanups) fn();
    cleanups = [];
  }

  function show(id) {
    if (!sections.some((s) => s.id === id)) id = "pcs";
    current = id;
    cleanup();
    for (const s of sections) {
      const on = s.id === id;
      tabs[s.id].setAttribute("aria-selected", String(on));
      tabs[s.id].tabIndex = on ? 0 : -1;
    }
    tabs[id].scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const render = { pcs: renderPcs, equipo: renderTeam, plan: renderPlan, perfil: renderProfile, admin: renderAdmin }[id];
    put(body, loading());
    render(body);
  }

  // ---------------------------------------------------------------- PCs

  async function renderPcs(box) {
    let pcs;
    try {
      pcs = await get("/api/pcs", { quiet: true });
    } catch (ex) {
      if (current === "pcs") put(box, loadError(ex.message, () => show("pcs")));
      return;
    }
    if (current !== "pcs") return;
    pcs = Array.isArray(pcs) ? pcs : [];
    const max = me()?.plan?.maxPcs ?? 1;
    const full = pcs.length >= max;
    const pairBox = h("div", { class: "pair-box" });
    const list = h("div", { class: "pc-list" });

    let pairNote = null;
    if (!canPair()) pairNote = "Solo el dueño o un operador pueden vincular PCs.";
    else if (!planActive()) pairNote = "Tu plan venció: renuévalo para vincular PCs nuevos.";
    else if (full) pairNote = `Tu plan permite ${pcsText(max)}. Desvincula uno o cambia de plan para agregar más.`;

    const pairBtn = h(
      "button",
      { type: "button", class: "btn btn-arm", disabled: !!pairNote, onclick: () => startPairing() },
      icon("plus"),
      "Vincular un PC",
    );

    put(box, 
      sectionHead("PCs vinculados", `${pcs.length} de ${pcsText(max)} en tu plan`, canPair() ? pairBtn : null),
      pairNote && canPair() ? h("p", { class: "note acct-note" }, pairNote) : null,
      pairBox,
      list,
    );
    drawList();

    function drawList() {
      if (!pcs.length) {
        put(list, 
          h(
            "div",
            { class: "empty" },
            h("p", null, h("strong", null, "Aún no hay PCs vinculados.")),
            h("p", { class: "muted" }, canPair() ? "Toca «Vincular un PC» y sigue los pasos en el PC donde corre Resolume." : "Pídele al dueño de la cuenta que vincule el PC de Resolume."),
          ),
        );
        return;
      }
      const sorted = [...pcs].sort((a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name), "es"));
      put(list, ...sorted.map(pcCard));
    }

    function pcCard(pc) {
      const seen = toMs(pc.lastSeenAt);
      const status = pc.online
        ? h("span", { class: "status status-on" }, h("span", { class: "dot" }), "En línea")
        : h("span", { class: "status status-off" }, h("span", { class: "dot" }), seen ? `Fuera de línea · ${ago(Date.now() - seen)}` : "Nunca se ha conectado");
      const res = pc.online
        ? pc.resolumeOnline
          ? h("span", { class: "status status-on" }, "Resolume conectado")
          : h("span", { class: "status status-warn" }, "Resolume sin respuesta")
        : null;
      const card = h(
        "article",
        { class: `card pc-card ${pc.online ? "" : "is-offline"}` },
        h("div", { class: "pc-card-head" }, h("h3", { class: "pc-name" }, pc.name || "PC sin nombre")),
        h("div", { class: "event-status" }, status, res),
        h(
          "p",
          { class: "muted small" },
          pc.version ? `Agente ${pc.version} · ` : "",
          `Vinculado el ${shortDate(pc.createdAt)}`,
        ),
      );
      const actions = h("div", { class: "pc-actions" });
      if (canPair()) actions.append(h("button", { type: "button", class: "btn btn-sm", onclick: () => rename() }, icon("edit"), "Renombrar"));
      if (isOwner())
        actions.append(
          h(
            "button",
            {
              type: "button",
              class: "btn btn-sm btn-danger-outline",
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `¿Desvincular «${pc.name}»?`,
                  body: "Ese PC deja de aparecer en el panel y su agente ya no podrá conectarse. Para volver a usarlo hay que vincularlo de nuevo con un código.",
                  ok: "Desvincular",
                  danger: true,
                });
                if (!ok) return;
                try {
                  await del(`/api/pcs/${encodeURIComponent(pc.id)}`);
                  toast(`«${pc.name}» desvinculado`, "ok");
                  if (current === "pcs") show("pcs");
                } catch {
                  /* aviso ya mostrado */
                }
              },
            },
            icon("trash"),
            "Desvincular",
          ),
        );
      if (actions.children.length) card.append(actions);

      function rename() {
        const input = h("input", { type: "text", value: pc.name || "", maxlength: "40", required: true, "aria-label": "Nombre del PC", class: "input" });
        const form = h(
          "form",
          {
            class: "pc-rename",
            onsubmit: async (e) => {
              e.preventDefault();
              const name = input.value.trim();
              if (!name) return input.focus();
              try {
                await patch(`/api/pcs/${encodeURIComponent(pc.id)}`, { name });
                pc.name = name;
                toast("Nombre guardado", "ok");
                drawList();
              } catch {
                input.focus();
              }
            },
          },
          input,
          h("div", { class: "pc-actions" }, h("button", { type: "button", class: "btn btn-sm", onclick: drawList }, "Cancelar"), h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Guardar")),
        );
        actions.replaceWith(form);
        input.focus();
        input.select();
      }
      return card;
    }

    async function startPairing() {
      pairBtn.disabled = true;
      let r;
      try {
        r = await post("/api/pcs/pairing-code");
      } catch {
        pairBtn.disabled = false;
        return;
      }
      if (current !== "pcs") return;
      const expires = toMs(r.expiresAt) ?? Date.now() + 15 * 60e3;
      const known = new Set(pcs.map((p) => p.id));
      const left = h("span", { class: "mono" });
      const codeEl = h("p", { class: "pair-code mono", "aria-label": `Código ${prettyCode(r.code).split("").join(" ")}` }, prettyCode(r.code));
      const agent = S.cfg?.agent;
      const dl = agent?.downloadUrl
        ? h("a", { href: agent.downloadUrl, class: "btn btn-sm", rel: "noopener" }, icon("download"), agent.version ? `Descargar agente ${agent.version}` : "Descargar agente")
        : h("span", { class: "muted" }, "(descarga pronto disponible)");
      const panel = h(
        "section",
        { class: "card pair-panel", "aria-live": "polite" },
        h("div", { class: "row-between" }, h("span", { class: "legend" }, "Código de vinculación"), h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Cerrar", onclick: close }, icon("close"))),
        codeEl,
        h("p", { class: "pair-left" }, "Vence en ", left),
        h(
          "ol",
          { class: "pair-steps" },
          h("li", null, h("span", null, "Descarga el agente en el PC de Resolume "), dl),
          h("li", null, "Ábrelo: se abre una página en el navegador de ese PC."),
          h("li", null, "Escribe este código y un nombre para el PC (p. ej. «Cabina tarima»)."),
        ),
        h("p", { class: "muted small" }, "Cuando el PC quede vinculado aparecerá aquí solo. Resolume debe tener activo el webserver (Preferencias → Webserver)."),
      );
      put(pairBox, panel);
      panel.scrollIntoView?.({ block: "nearest" });

      const tick = () => {
        const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
        left.textContent = mmss(s);
        if (s === 0) {
          stopTimers();
          codeEl.classList.add("is-expired");
          panel.querySelector(".pair-left").replaceChildren(
            h("span", null, "Este código venció. "),
            h("button", { type: "button", class: "link-btn", onclick: () => startPairing() }, "Generar otro"),
          );
        }
      };
      const poll = async () => {
        try {
          const now = await get("/api/pcs", { quiet: true });
          const fresh = (Array.isArray(now) ? now : []).find((p) => !known.has(p.id));
          if (fresh && current === "pcs") {
            toast(`PC vinculado: ${fresh.name}`, "ok", 5000);
            stopTimers();
            show("pcs");
          }
        } catch {
          /* se reintenta */
        }
      };
      const t1 = setInterval(tick, 1000);
      const t2 = setInterval(poll, 4000);
      function stopTimers() {
        clearInterval(t1);
        clearInterval(t2);
      }
      function close() {
        stopTimers();
        put(pairBox, );
        pairBtn.disabled = !!pairNote;
        pairBtn.focus();
      }
      cleanups.push(stopTimers);
      tick();
    }
  }

  // ---------------------------------------------------------------- Equipo

  async function renderTeam(box) {
    let data;
    try {
      data = await get("/api/team", { quiet: true });
    } catch (ex) {
      if (current === "equipo") put(box, loadError(ex.message, () => show("equipo")));
      return;
    }
    if (current !== "equipo") return;
    const members = Array.isArray(data) ? data : data?.members || [];
    const invites = Array.isArray(data) ? [] : data?.invites || data?.pending || [];
    const myId = me()?.user?.id;
    const owner = isOwner();
    const inviteBox = h("div", { class: "invite-box" });

    const inviteBtn = owner ? h("button", { type: "button", class: "btn btn-arm", onclick: () => openInvite() }, icon("plus"), "Invitar") : null;
    put(box, 
      sectionHead("Equipo", owner ? "Invita a tu equipo y decide quién controla." : "Las personas de tu empresa.", inviteBtn),
      inviteBox,
      h("div", { class: "member-list" }, members.map(memberRow)),
      owner && invites.length
        ? h("section", { class: "acct-sub" }, h("h3", { class: "legend" }, "Invitaciones pendientes"), h("div", { class: "member-list" }, invites.map(inviteRow)))
        : null,
      h(
        "dl",
        { class: "role-legend" },
        Object.keys(ROLE_LABEL).map((r) => h("div", null, h("dt", null, ROLE_LABEL[r]), h("dd", null, ROLE_HELP[r]))),
      ),
    );

    function memberRow(m) {
      const self = m.userId === myId;
      const row = h(
        "div",
        { class: "card member" },
        h(
          "div",
          { class: "member-main" },
          h("p", { class: "member-name" }, m.name || m.email, self ? h("span", { class: "muted" }, " (tú)") : null),
          h("p", { class: "muted small member-email" }, m.email),
        ),
      );
      if (owner && !self) {
        const sel = h(
          "select",
          {
            class: "input input-sm",
            "aria-label": `Rol de ${m.name}`,
            onchange: async () => {
              const prev = m.role;
              sel.disabled = true;
              try {
                await patch(`/api/team/${encodeURIComponent(m.userId)}`, { role: sel.value });
                m.role = sel.value;
                toast(`${m.name}: ${ROLE_LABEL[sel.value]}`, "ok");
              } catch {
                sel.value = prev;
              } finally {
                sel.disabled = false;
              }
            },
          },
          Object.keys(ROLE_LABEL).map((r) => h("option", { value: r, selected: m.role === r }, ROLE_LABEL[r])),
        );
        row.append(
          h(
            "div",
            { class: "member-ctl" },
            sel,
            h(
              "button",
              {
                type: "button",
                class: "btn btn-sm btn-icon btn-danger-outline",
                "aria-label": `Sacar a ${m.name} del equipo`,
                onclick: async () => {
                  const ok = await confirmDialog({ title: `¿Sacar a ${m.name}?`, body: "Se cierra su sesión y ya no podrá ver ni controlar los eventos de tu empresa.", ok: "Sacar del equipo", danger: true });
                  if (!ok) return;
                  try {
                    await del(`/api/team/${encodeURIComponent(m.userId)}`);
                    toast(`${m.name} ya no está en el equipo`, "ok");
                    show("equipo");
                  } catch {
                    /* aviso ya mostrado */
                  }
                },
              },
              icon("trash"),
            ),
          ),
        );
      } else {
        row.append(h("span", { class: `role-chip ${m.role !== "viewer" ? "is-admin" : ""}` }, ROLE_LABEL[m.role] || m.role));
      }
      return row;
    }

    function inviteUrl(inv) {
      return inv.url || `${location.origin}/app/#invitacion-${inv.code}`;
    }

    function inviteRow(inv) {
      return h(
        "div",
        { class: "card member" },
        h(
          "div",
          { class: "member-main" },
          h("p", { class: "member-name" }, ROLE_LABEL[inv.role] || inv.role),
          h("p", { class: "muted small" }, `Vence el ${shortDate(inv.expiresAt)}`),
        ),
        h(
          "div",
          { class: "member-ctl" },
          h("button", { type: "button", class: "btn btn-sm", onclick: () => copyText(inviteUrl(inv)) }, icon("copy"), "Copiar"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-sm btn-danger-outline",
              onclick: async () => {
                const ok = await confirmDialog({ title: "¿Anular esta invitación?", body: "El enlace deja de funcionar.", ok: "Anular", danger: true });
                if (!ok) return;
                try {
                  await del(`/api/invites/${encodeURIComponent(inv.code)}`);
                  toast("Invitación anulada", "ok");
                  show("equipo");
                } catch {
                  /* aviso ya mostrado */
                }
              },
            },
            "Anular",
          ),
        ),
      );
    }

    function openInvite() {
      inviteBtn.disabled = true;
      const name = "inv-role";
      const seg = (value, label) =>
        h("div", { class: "seg" }, h("input", { type: "radio", name, id: `${name}-${value}`, value, checked: value === "operator" }), h("label", { for: `${name}-${value}` }, label));
      const help = h("p", { class: "field-help" }, ROLE_HELP.operator);
      const form = h(
        "form",
        {
          class: "card invite-form",
          onchange: () => (help.textContent = ROLE_HELP[form.elements[name].value]),
          onsubmit: async (e) => {
            e.preventDefault();
            const role = form.elements[name].value;
            const btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            try {
              const r = await post("/api/invites", { role });
              showInvite(r, role);
            } catch {
              btn.disabled = false;
            }
          },
        },
        h("fieldset", { class: "field" }, h("legend", null, "¿Qué podrá hacer?"), h("div", { class: "segmented" }, seg("operator", "Operador"), seg("viewer", "Observador")), help),
        h("div", { class: "pc-actions" }, h("button", { type: "button", class: "btn btn-sm", onclick: closeInvite }, "Cancelar"), h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Crear enlace")),
      );
      put(inviteBox, form);
      form.querySelector("input").focus();
    }

    function showInvite(r, role) {
      const url = inviteUrl(r);
      const msg = `Te invito al equipo de ${me()?.org?.name || "mi empresa"} en ${brand()} como ${ROLE_LABEL[role].toLowerCase()}. Crea tu acceso aquí: ${url}`;
      const urlInput = h("input", { type: "text", readonly: true, value: url, class: "input mono invite-url", "aria-label": "Enlace de invitación", onfocus: (e) => e.target.select() });
      put(inviteBox, 
        h(
          "section",
          { class: "card invite-done", "aria-live": "polite" },
          h("div", { class: "row-between" }, h("span", { class: "legend" }, `Invitación de ${ROLE_LABEL[role].toLowerCase()} lista`), h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Cerrar", onclick: () => show("equipo") }, icon("close"))),
          urlInput,
          h(
            "div",
            { class: "invite-actions" },
            h("button", { type: "button", class: "btn", onclick: () => copyText(url) }, icon("copy"), "Copiar enlace"),
            h("a", { class: "btn btn-wa", href: waLink("", msg), target: "_blank", rel: "noopener" }, icon("send"), "Enviar por WhatsApp"),
          ),
          h("p", { class: "muted small" }, `Sirve una sola vez y vence el ${shortDate(r.expiresAt)}.`),
        ),
      );
    }

    function closeInvite() {
      put(inviteBox, );
      inviteBtn.disabled = false;
      inviteBtn.focus();
    }
  }

  // ---------------------------------------------------------------- Plan

  async function renderPlan(box) {
    const [plans, pcs] = await Promise.all([loadPlans(), get("/api/pcs", { quiet: true }).catch(() => null)]);
    if (current !== "plan") return;
    const p = me()?.plan || {};
    const active = p.active !== false;
    const used = Array.isArray(pcs) ? pcs.length : null;
    const max = p.maxPcs ?? 1;
    const days = Number.isFinite(p.daysLeft) ? Math.max(0, Math.floor(p.daysLeft)) : null;
    const wa = !!S.cfg?.contactWhatsapp;
    const owner = isOwner();

    const usage = used != null ? Math.min(1, used / Math.max(1, max)) : 0;
    const current_ = h(
      "section",
      { class: `card plan-now ${active ? "" : "is-expired"}` },
      h("div", { class: "row-between" }, h("span", { class: "legend" }, "Tu plan"), h("span", { class: `tally ${active ? "tally-ok" : "tally-air"}` }, active ? "ACTIVO" : "VENCIDO")),
      h("p", { class: "plan-name" }, p.name || "—"),
      h(
        "dl",
        { class: "plan-facts" },
        h("div", null, h("dt", null, active ? "Días restantes" : "Venció"), h("dd", { class: "mono" }, active ? (days ?? "—") : shortDate(p.expiresAt))),
        h("div", null, h("dt", null, "Vence"), h("dd", null, shortDate(p.expiresAt))),
        h("div", null, h("dt", null, "PCs"), h("dd", { class: "mono" }, used != null ? `${used} / ${max}` : `máx. ${max}`)),
      ),
      h("div", { class: "meter", role: "img", "aria-label": `PCs usados: ${used ?? "?"} de ${max}` }, h("div", { class: "meter-fill", style: { width: `${Math.round(usage * 100)}%` } })),
      !active ? h("p", { class: "note" }, "Puedes entrar y mirar, pero no controlar ni vincular PCs. Los PCs siguen conectados y sus automatizaciones siguen corriendo.") : null,
      wa && owner ? h("a", { class: "btn btn-wa btn-block", href: planWaLink(active ? null : p.name), target: "_blank", rel: "noopener" }, icon("send"), active ? "Renovar o cambiar de plan" : "Renovar por WhatsApp") : null,
    );

    const cards = plans
      .filter((x) => !(x.trialDays && x.priceCop === 0) || p.id === x.id)
      .map((x) =>
        h(
          "article",
          { class: `card plan-card ${x.id === p.id ? "is-current" : ""}` },
          h("div", { class: "row-between" }, h("h3", { class: "plan-card-name" }, x.name), x.id === p.id ? h("span", { class: "chip" }, "Tu plan") : null),
          h("p", { class: "plan-price" }, priceText(x)),
          h("p", { class: "plan-pcs" }, `Hasta ${pcsText(x.maxPcs)}`),
          x.features?.length ? h("ul", { class: "plan-feats" }, x.features.map((f) => h("li", null, icon("check"), h("span", null, f)))) : null,
          wa && owner && x.priceCop > 0
            ? h("a", { class: "btn btn-sm btn-block", href: planWaLink(x.name + ` (${cop(x.priceCop)}/mes)`), target: "_blank", rel: "noopener" }, x.id === p.id ? "Renovar este plan" : "Quiero este plan")
            : null,
        ),
      );

    put(box, 
      sectionHead("Plan", "Precios en pesos colombianos, pago mensual."),
      current_,
      h("div", { class: "plan-grid" }, cards),
      h(
        "p",
        { class: "muted small acct-foot" },
        owner
          ? wa
            ? "Para activar o cambiar de plan escríbenos por WhatsApp: pagas por Nequi o transferencia y lo activamos el mismo día."
            : "Para activar o cambiar de plan escríbenos: pagas por Nequi o transferencia y lo activamos el mismo día."
          : "Solo el dueño de la cuenta puede cambiar el plan.",
      ),
    );
  }

  // ---------------------------------------------------------------- Mi perfil

  function renderProfile(box) {
    const m = me();
    const nameIn = h("input", { type: "text", id: "pf-name", value: m?.user?.name || "", maxlength: "40", required: true, autocomplete: "name" });
    const nameForm = h(
      "form",
      {
        class: "card acct-form",
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameIn.value.trim();
          if (!name) return nameIn.focus();
          try {
            await patch("/api/me", { name });
            toast("Nombre guardado", "ok");
            await opts.refreshMe();
          } catch {
            /* aviso ya mostrado */
          }
        },
      },
      h("div", { class: "field" }, h("label", { for: "pf-name" }, "Tu nombre"), nameIn, h("p", { class: "field-help" }, "Se ve en el registro de cada evento.")),
      h("div", { class: "field" }, h("label", null, "Correo"), h("p", { class: "mono acct-static" }, m?.user?.email || "")),
      h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Guardar nombre"),
    );

    let orgForm = null;
    if (isOwner()) {
      const orgIn = h("input", { type: "text", id: "pf-org", value: m?.org?.name || "", maxlength: "60", required: true, autocomplete: "organization" });
      orgForm = h(
        "form",
        {
          class: "card acct-form",
          onsubmit: async (e) => {
            e.preventDefault();
            const name = orgIn.value.trim();
            if (name.length < 2) return orgIn.focus();
            try {
              await patch("/api/org", { name });
              toast("Nombre de la empresa guardado", "ok");
              await opts.refreshMe();
            } catch {
              /* aviso ya mostrado */
            }
          },
        },
        h("div", { class: "field" }, h("label", { for: "pf-org" }, "Nombre de la empresa"), orgIn),
        h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Guardar empresa"),
      );
    }

    const cur = h("input", { type: "password", id: "pf-cur", autocomplete: "current-password", required: true });
    const nw = h("input", { type: "password", id: "pf-new", autocomplete: "new-password", minlength: "8", required: true });
    const nw2 = h("input", { type: "password", id: "pf-new2", autocomplete: "new-password", minlength: "8", required: true });
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const passForm = h(
      "form",
      {
        class: "card acct-form",
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          const fail = (t, el) => {
            err.textContent = t;
            err.hidden = false;
            el.focus();
          };
          if (!cur.value) return fail("Escribe tu contraseña actual.", cur);
          if (nw.value.length < 8) return fail("La nueva contraseña debe tener al menos 8 caracteres.", nw);
          if (nw.value !== nw2.value) return fail("Las dos contraseñas nuevas no coinciden.", nw2);
          try {
            const r = await patch("/api/me", { password: nw.value, currentPassword: cur.value }, { quiet: true });
            opts.onPasswordChanged(r);
          } catch (ex) {
            fail(ex.message, cur);
          }
        },
      },
      h("h3", { class: "acct-form-title" }, "Cambiar contraseña"),
      h("div", { class: "field" }, h("label", { for: "pf-cur" }, "Contraseña actual"), cur),
      h("div", { class: "field" }, h("label", { for: "pf-new" }, "Nueva contraseña"), nw, h("p", { class: "field-help" }, "Mínimo 8 caracteres. Se cierran tus sesiones en otros equipos.")),
      h("div", { class: "field" }, h("label", { for: "pf-new2" }, "Repite la nueva"), nw2),
      err,
      h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Cambiar contraseña"),
    );

    put(box, 
      sectionHead("Mi perfil", `${ROLE_LABEL[role()]} en ${m?.org?.name || "tu empresa"}`),
      h("div", { class: "acct-forms" }, nameForm, orgForm, passForm),
      h("button", { type: "button", class: "btn btn-block btn-ghost-line", onclick: opts.onLogout }, icon("logout"), "Cerrar sesión"),
    );
  }

  // ---------------------------------------------------------------- Superadmin

  async function renderAdmin(box) {
    let orgs;
    const plans = await loadPlans();
    try {
      orgs = await get("/api/admin/orgs", { quiet: true });
    } catch (ex) {
      if (current === "admin") put(box, loadError(ex.message, () => show("admin")));
      return;
    }
    if (current !== "admin") return;
    orgs = Array.isArray(orgs) ? orgs : [];
    const planName = (id) => plans.find((p) => p.id === id)?.name || id;
    const list = h("div", { class: "org-list" });
    const q = h("input", { type: "search", class: "input", placeholder: "Buscar empresa o correo", "aria-label": "Buscar empresa", oninput: draw });
    const now = Date.now();
    const expired = orgs.filter((o) => (toMs(o.planExpiresAt) ?? Infinity) < now).length;
    const online = orgs.reduce((n, o) => n + (o.pcsOnline || 0), 0);

    put(box, 
      sectionHead("Superadmin", `${orgs.length} empresas · ${expired} vencidas · ${online} PCs en línea`),
      h("div", { class: "field" }, q),
      list,
    );
    draw();

    function draw() {
      const term = q.value.trim().toLowerCase();
      const rows = orgs
        .filter((o) => !term || [o.name, ...(o.owners || []).flatMap((w) => [w.name, w.email])].some((s) => String(s || "").toLowerCase().includes(term)))
        .sort((a, b) => (toMs(a.planExpiresAt) ?? 0) - (toMs(b.planExpiresAt) ?? 0));
      put(list, ...(rows.length ? rows.map(orgCard) : [h("p", { class: "empty" }, "Sin resultados.")]));
    }

    function orgCard(o) {
      const exp = toMs(o.planExpiresAt);
      const isExp = exp != null && exp < Date.now();
      const daysLeft = exp != null ? Math.ceil((exp - Date.now()) / 864e5) : null;
      const card = h(
        "article",
        { class: `card org-card ${isExp ? "is-expired" : ""}` },
        h("div", { class: "row-between" }, h("h3", { class: "pc-name" }, o.name), h("span", { class: `tally ${isExp ? "tally-air" : "tally-ok"}` }, planName(o.plan))),
        h(
          "dl",
          { class: "plan-facts org-facts" },
          h("div", null, h("dt", null, "Vence"), h("dd", null, shortDate(o.planExpiresAt), daysLeft != null ? h("span", { class: "muted small" }, isExp ? " (vencido)" : ` (${daysLeft} d)`) : null)),
          h("div", null, h("dt", null, "PCs en línea"), h("dd", { class: "mono" }, `${o.pcsOnline ?? 0} / ${o.pcs ?? 0}`)),
          h("div", null, h("dt", null, "Personas"), h("dd", { class: "mono" }, String(o.members ?? "—"))),
        ),
        h(
          "ul",
          { class: "org-owners" },
          (o.owners || []).map((w) => h("li", null, h("span", null, w.name), " ", h("a", { href: `mailto:${w.email}`, class: "muted" }, w.email))),
        ),
        h("p", { class: "muted small" }, `Creada el ${shortDate(o.createdAt)}`),
      );
      const edit = h("button", { type: "button", class: "btn btn-sm", onclick: () => openEdit() }, icon("edit"), "Editar plan");
      const actions = h("div", { class: "pc-actions" }, edit);
      card.append(actions);

      function openEdit() {
        const sel = h("select", { class: "input", id: `org-plan-${o.id}` }, plans.map((p) => h("option", { value: p.id, selected: p.id === o.plan }, `${p.name} · ${pcsText(p.maxPcs)}`)));
        const dateIn = h("input", { type: "date", class: "input", id: `org-exp-${o.id}`, value: exp ? isoDay(exp) : "" });
        const bump = (days) => {
          const base = Math.max(Date.now(), toMs(dateIn.value + "T12:00:00") ?? 0);
          dateIn.value = isoDay(base + days * 864e5);
        };
        const form = h(
          "form",
          {
            class: "org-edit",
            onsubmit: async (e) => {
              e.preventDefault();
              if (!dateIn.value) return dateIn.focus();
              const ms = new Date(dateIn.value + "T23:59:59").getTime();
              // Se devuelve en el mismo formato en que llegó (ms o texto ISO).
              const planExpiresAt = typeof o.planExpiresAt === "string" ? new Date(ms).toISOString() : ms;
              try {
                await patch(`/api/admin/orgs/${encodeURIComponent(o.id)}`, { plan: sel.value, planExpiresAt });
                o.plan = sel.value;
                o.planExpiresAt = planExpiresAt;
                toast(`${o.name}: ${planName(sel.value)} hasta ${shortDate(ms)}`, "ok");
                draw();
              } catch {
                /* aviso ya mostrado */
              }
            },
          },
          h("div", { class: "field-pair" }, h("div", { class: "field" }, h("label", { for: sel.id }, "Plan"), sel), h("div", { class: "field" }, h("label", { for: dateIn.id }, "Vence"), dateIn)),
          h("div", { class: "chip-row" }, h("button", { type: "button", class: "chip-btn", onclick: () => bump(30) }, "+30 días"), h("button", { type: "button", class: "chip-btn", onclick: () => bump(365) }, "+1 año")),
          h("div", { class: "pc-actions" }, h("button", { type: "button", class: "btn btn-sm", onclick: draw }, "Cancelar"), h("button", { type: "submit", class: "btn btn-sm btn-primary" }, "Guardar")),
        );
        actions.replaceWith(form);
        sel.focus();
      }
      return card;
    }
  }

  show(current);

  return {
    show,
    get section() {
      return current;
    },
    /** Rehace la sección (p. ej. si cambió el plan). */
    refresh: () => show(current),
    destroy: cleanup,
  };
}

function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
