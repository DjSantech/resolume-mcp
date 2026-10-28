// HTML de la página local del agente (una sola página; se pinta con los datos de /api/estado).
// Los datos del servidor (empresa, PC) se insertan con textContent, nunca como HTML.

import { BRAND_NAME } from "./brand.js";

export function renderPage(token: string, nonce: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="vm-token" content="${token}">
<title>${BRAND_NAME} · Agente</title>
<style>
:root{--bg:#0b0c0e;--panel:#14161a;--line:#24272e;--text:#e7e5df;--muted:#8b8f98;--amber:#ffb020;--amber-d:#c98500;--ok:#3fd47a;--bad:#ff5c5c;--warn:#ffb020;
--mono:ui-monospace,"Cascadia Mono",Consolas,monospace;--sans:"Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 var(--sans);min-height:100vh;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:520px}
header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.logo{width:36px;height:36px;border-radius:8px;background:var(--amber);color:#111;font:700 18px var(--mono);display:grid;place-items:center}
h1{font-size:18px;margin:0;letter-spacing:.02em}
.sub{color:var(--muted);font:12px var(--mono)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 4px}
p{margin:0 0 14px;color:var(--muted)}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}
input[type=text],input[type=url]{width:100%;padding:12px;border-radius:8px;border:1px solid var(--line);background:#0e1013;color:var(--text);font:16px var(--sans)}
input.code{font:600 26px var(--mono);letter-spacing:.25em;text-transform:uppercase;text-align:center}
input:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted);font-size:13px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:8px;border:1px solid var(--line);background:#1c1f25;color:var(--text);font:600 14px var(--sans);cursor:pointer;text-decoration:none}
button.primary,.btn.primary{background:var(--amber);border-color:var(--amber);color:#111}
button.primary:hover,.btn.primary:hover{background:var(--amber-d)}
button.danger{border-color:#5a2a2a;color:#ff8a8a}
button:disabled{opacity:.5;cursor:default}
.full{width:100%;margin-top:18px}
.err{color:var(--bad);font-size:14px;margin-top:12px;min-height:1em}
.err:empty{display:none}
.rows{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;font-size:14px}
.rows dt{color:var(--muted)}.rows dd{margin:0;font-family:var(--mono);word-break:break-word}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:var(--muted);vertical-align:middle}
.dot.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}
.switch{position:relative;width:48px;height:28px;flex:none}
.switch input{opacity:0;width:100%;height:100%;margin:0;position:absolute;cursor:pointer}
.switch span{position:absolute;inset:0;border-radius:14px;background:#2a2d34;pointer-events:none;transition:background .15s}
.switch span::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#ddd;transition:transform .15s}
.switch input:checked+span{background:var(--amber)}.switch input:checked+span::after{transform:translateX(20px)}
.switch input:focus-visible+span{outline:2px solid var(--amber);outline-offset:2px}
.note{font-size:13px;color:var(--muted);margin-top:10px}
.confirm{border:1px solid #5a2a2a;background:#1d1214;border-radius:8px;padding:14px;margin-top:12px}
.hidden{display:none!important}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<main>
<header><div class="logo">V</div><div><h1>${BRAND_NAME}</h1><div class="sub" id="ver">Agente</div></div></header>

<section id="v-cargando" class="card"><p>Cargando…</p></section>

<section id="v-vincular" class="card hidden">
  <h2>Vincular este PC</h2>
  <p>En el panel web, ve a <b>PCs → Vincular PC</b> y copia el código.</p>
  <form id="f-vincular" novalidate>
    <label for="code">Código de vinculación</label>
    <input id="code" class="code" type="text" maxlength="9" autocomplete="off" spellcheck="false" placeholder="K7P-Q3X" required>
    <label for="pc">Nombre del PC</label>
    <input id="pc" type="text" maxlength="60" autocomplete="off">
    <details><summary>Avanzado</summary>
      <label for="srv">Servidor</label>
      <input id="srv" type="url" autocomplete="off" spellcheck="false">
    </details>
    <button class="primary full" id="b-vincular" type="submit">Vincular</button>
    <div class="err" id="e-vincular" role="alert"></div>
  </form>
</section>

<section id="v-estado" class="hidden">
  <div class="card">
    <dl class="rows">
      <dt>Servidor</dt><dd id="s-srv"></dd>
      <dt>Resolume</dt><dd id="s-res"></dd>
      <dt>Empresa</dt><dd id="s-org"></dd>
      <dt>PC</dt><dd id="s-pc"></dd>
      <dt>Automatización</dt><dd id="s-auto"></dd>
      <dt>Agente</dt><dd id="s-ver"></dd>
    </dl>
    <div class="note" id="s-update"></div>
  </div>
  <div class="card">
    <div class="actions">
      <a class="btn primary" id="b-panel" target="_blank" rel="noopener noreferrer">Abrir panel</a>
      <button class="danger" id="b-desv" type="button">Desvincular este PC</button>
    </div>
    <div class="confirm hidden" id="c-desv">
      <p style="color:var(--text)">¿Desvincular este PC? Se detiene el puente y se borran las credenciales. Para volver a usarlo necesitarás un código nuevo.</p>
      <div class="actions"><button class="danger" id="b-desv-si" type="button">Sí, desvincular</button><button id="b-desv-no" type="button">Cancelar</button></div>
    </div>
    <div class="err" id="e-estado" role="alert"></div>
  </div>
  <div class="card">
    <div class="toggle"><div><h2>Iniciar con Windows</h2><div class="note" id="n-auto" style="margin:0">Arranca oculto al encender el PC.</div></div>
    <label class="switch" aria-label="Iniciar con Windows"><input type="checkbox" id="t-auto"><span></span></label></div>
  </div>
</section>
</main>
<script nonce="${nonce}">
const TOKEN = document.querySelector('meta[name="vm-token"]').content;
const $ = (id) => document.getElementById(id);
let last = null, firstForm = true, busy = false;

async function api(path, body) {
  const opts = { headers: { "x-vm-token": TOKEN } };
  if (body !== undefined) { opts.method = "POST"; opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("Error " + r.status));
  return data;
}

function show(id) { for (const v of ["v-cargando", "v-vincular", "v-estado"]) $(v).classList.toggle("hidden", v !== id); }
function line(el, cls, text) { el.textContent = ""; const d = document.createElement("span"); d.className = "dot " + cls; el.append(d, text); }

function render(s) {
  last = s;
  $("ver").textContent = "Agente " + s.version;
  if (!s.paired) {
    show("v-vincular");
    if (firstForm) { firstForm = false; $("pc").value = s.hostname; $("srv").value = s.defaultServerUrl; $("code").focus(); }
    return;
  }
  firstForm = true;
  show("v-estado");
  const sv = s.server;
  if (sv.connected) line($("s-srv"), "ok", "Conectado");
  else if (sv.rejected) line($("s-srv"), "bad", "Rechazado: " + (sv.error || "credenciales inválidas") + ". Desvincula y vuelve a vincular.");
  else line($("s-srv"), "warn", "Conectando…" + (sv.error ? " (" + sv.error + ")" : ""));
  const r = s.resolume;
  if (r.online) line($("s-res"), "ok", (r.product || "Resolume") + (r.version ? " " + r.version : ""));
  else line($("s-res"), "bad", "Sin conexión (¿está abierto Resolume con el webserver activo?)");
  $("s-org").textContent = s.orgName || "—";
  $("s-pc").textContent = s.pcName || "—";
  $("s-auto").textContent = s.automation || "Ninguna";
  $("s-ver").textContent = s.version;
  $("s-update").textContent = s.update || "";
  $("b-panel").href = s.panelUrl;
  const t = $("t-auto");
  t.checked = !!s.autostart.enabled;
  t.disabled = !s.autostart.available || busy;
  $("n-auto").textContent = s.autostart.available ? "Arranca oculto al encender el PC." : "Disponible solo en el ejecutable instalado.";
}

async function refresh() {
  try { render(await api("/api/estado")); } catch (e) { if (last) $("e-estado").textContent = "Sin respuesta del agente: " + e.message; }
}

$("code").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  e.target.value = raw.length > 3 ? raw.slice(0, 3) + "-" + raw.slice(3) : raw;
});

$("f-vincular").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("b-vincular"), err = $("e-vincular");
  err.textContent = "";
  b.disabled = true; b.textContent = "Vinculando… (el servidor puede tardar hasta un minuto en despertar)";
  try {
    await api("/api/vincular", { code: $("code").value, pcName: $("pc").value, serverUrl: $("srv").value });
    $("code").value = "";
    await refresh();
  } catch (x) { err.textContent = x.message; }
  finally { b.disabled = false; b.textContent = "Vincular"; }
});

$("b-desv").addEventListener("click", () => $("c-desv").classList.remove("hidden"));
$("b-desv-no").addEventListener("click", () => $("c-desv").classList.add("hidden"));
$("b-desv-si").addEventListener("click", async () => {
  $("e-estado").textContent = "";
  try { await api("/api/desvincular", {}); $("c-desv").classList.add("hidden"); await refresh(); }
  catch (x) { $("e-estado").textContent = x.message; }
});
$("t-auto").addEventListener("change", async (e) => {
  busy = true; $("e-estado").textContent = "";
  try { await api("/api/inicio-windows", { enabled: e.target.checked }); }
  catch (x) { $("e-estado").textContent = x.message; }
  finally { busy = false; await refresh(); }
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
