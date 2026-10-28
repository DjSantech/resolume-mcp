// Agente: credenciales, puente, inicio con Windows y auto-actualización. La página local llama a estos métodos.

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { defaultEventId, startBridge, type Bridge } from "../bridge/bridge.js";
import { autostartCommand, disableAutostart, enableAutostart, readAutostart } from "./autostart.js";
import { DEFAULT_RESOLUME_URL, DEFAULT_SERVER_URL, BRAND_NAME } from "./brand.js";
import {
  cleanPcName, deleteCredentials, loadCredentials, normalizePairingCode, normalizeServerUrl, pairWithServer, saveCredentials,
  PairError, type Credentials,
} from "./credentials.js";
import type { AgentApi } from "./local-server.js";
import { HttpError } from "./local-server.js";
import type { Logger } from "./log.js";
import { bridgeDataDir, credentialsFile, updateDir } from "./paths.js";
import { cleanupOld, decideUpdate, downloadUpdate, fetchUpdateInfo, resolveDownloadUrl, swapExecutable } from "./update.js";
import { AGENT_VERSION } from "./version.js";

const UPDATE_EVERY_MS = 6 * 3600_000;
const UPDATE_WAIT_MS = 60_000;

export interface AgentOptions {
  dir: string;
  log: Logger;
  /** Corre como .exe (SEA): habilita inicio con Windows y auto-actualización. */
  packaged: boolean;
  exePath: string;
  resolumeUrl?: string;
  /** Se llama para salir tras instalar una actualización (cerrar la página local, etc.). */
  beforeRestart?: () => Promise<void>;
}

export class Agent implements AgentApi {
  private creds: Credentials | null = null;
  private bridge: Bridge | null = null;
  private autostart = false;
  private updateMsg = "";
  private updateTimer: NodeJS.Timeout | null = null;
  private updating = false;
  private pairing = false;
  private stopped = false;

  constructor(private readonly o: AgentOptions) {}

  get paired(): boolean {
    return !!this.creds;
  }

  async start(): Promise<void> {
    this.o.log(`${BRAND_NAME} agente ${AGENT_VERSION} (${this.o.packaged ? "ejecutable" : "desarrollo"})`);
    if (this.o.packaged) void cleanupOld(this.o.exePath);
    this.creds = await loadCredentials(credentialsFile(this.o.dir));
    if (this.creds) {
      this.o.log.addSecret(this.creds.agentSecret);
      await this.startBridge();
      // Si el .exe cambió de carpeta, apuntar el inicio con Windows a la nueva ruta.
      if (this.o.packaged) {
        const cmd = await readAutostart();
        this.autostart = cmd !== null;
        if (cmd !== null && cmd !== autostartCommand(this.o.exePath)) await enableAutostart(this.o.exePath).catch(() => undefined);
      }
    } else {
      this.o.log("Sin vincular: esperando código en la página local");
    }
    this.scheduleUpdate(5_000);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    await this.stopBridge();
  }

  status() {
    const b = this.bridge?.status();
    const c = this.creds;
    return {
      brand: BRAND_NAME,
      version: AGENT_VERSION,
      paired: !!c,
      hostname: hostname(),
      defaultServerUrl: DEFAULT_SERVER_URL,
      serverUrl: c?.serverUrl ?? "",
      panelUrl: c ? `${c.serverUrl}/app` : "",
      orgName: c?.orgName ?? "",
      pcName: c?.pcName ?? "",
      server: { connected: b?.serverConnected ?? false, rejected: b?.serverRejected ?? false, error: b?.serverError ?? "" },
      resolume: { online: b?.resolumeOnline ?? false, product: b?.resolume?.product ?? "", version: b?.resolume?.version ?? "" },
      automation: b?.automation ?? null,
      autostart: { available: this.o.packaged && process.platform === "win32", enabled: this.autostart },
      update: this.updateMsg,
    };
  }

  async pair(body: Record<string, unknown>): Promise<unknown> {
    if (this.creds) throw new HttpError(409, "Este PC ya está vinculado");
    if (this.pairing) throw new HttpError(409, "Ya se está vinculando");
    const code = normalizePairingCode(String(body.code ?? ""));
    if (!code) throw new HttpError(400, "Código inválido: son 6 letras o números, como K7P-Q3X");
    const serverUrl = normalizeServerUrl(String(body.serverUrl ?? "") || DEFAULT_SERVER_URL);
    if (!serverUrl) throw new HttpError(400, "Dirección del servidor inválida");
    const pcName = cleanPcName(String(body.pcName ?? ""), hostname());
    this.pairing = true;
    try {
      const creds = await pairWithServer(serverUrl, code, pcName, AGENT_VERSION);
      this.o.log.addSecret(creds.agentSecret);
      await saveCredentials(credentialsFile(this.o.dir), creds);
      this.creds = creds;
      this.o.log(`Vinculado a "${creds.orgName}" como "${creds.pcName}" (${serverUrl})`);
      await this.startBridge();
      if (this.o.packaged) await this.setAutostart(true).catch((e) => this.o.log(`Inicio con Windows: ${(e as Error).message}`));
      this.scheduleUpdate(2_000);
      return { ok: true };
    } catch (e) {
      if (e instanceof PairError) throw new HttpError(400, e.message);
      throw e;
    } finally {
      this.pairing = false;
    }
  }

  async unpair(): Promise<void> {
    await this.stopBridge();
    await deleteCredentials(credentialsFile(this.o.dir));
    this.creds = null;
    if (this.o.packaged) await this.setAutostart(false).catch(() => undefined);
    this.o.log("Desvinculado: credenciales borradas");
  }

  async setAutostart(enabled: boolean): Promise<void> {
    if (!this.o.packaged) throw new HttpError(400, "Disponible solo en el ejecutable");
    if (enabled) await enableAutostart(this.o.exePath);
    else await disableAutostart();
    this.autostart = (await readAutostart()) !== null;
    this.o.log(`Inicio con Windows: ${this.autostart ? "activado" : "desactivado"}`);
  }

  private async startBridge(): Promise<void> {
    const c = this.creds;
    if (!c || this.bridge) return;
    this.bridge = await startBridge({
      resolumeUrl: this.o.resolumeUrl || DEFAULT_RESOLUME_URL,
      serverUrl: c.serverUrl,
      agentId: c.agentId,
      agentSecret: c.agentSecret,
      eventId: defaultEventId(),
      eventName: c.pcName,
      dataDir: bridgeDataDir(this.o.dir),
      logger: (line) => this.o.log(`puente ${line}`),
    });
  }

  private async stopBridge(): Promise<void> {
    const b = this.bridge;
    this.bridge = null;
    await b?.stop().catch(() => undefined);
  }

  // ---------------------------------------------------------------- Actualización

  private scheduleUpdate(delay: number): void {
    if (this.stopped) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      void this.checkUpdate();
    }, delay);
    this.updateTimer.unref?.();
  }

  /** Consulta la versión publicada y, si toca, instala. Devuelve la siguiente espera. */
  private async checkUpdate(): Promise<void> {
    if (this.updating || this.stopped) return;
    const serverUrl = this.creds?.serverUrl ?? DEFAULT_SERVER_URL;
    let next = UPDATE_EVERY_MS;
    this.updating = true;
    try {
      const info = await fetchUpdateInfo(serverUrl);
      const d = decideUpdate({ current: AGENT_VERSION, info, packaged: this.o.packaged, automationRunning: !!this.bridge?.status().automation });
      if (d.action === "none") {
        if (d.reason !== "Al día" && d.reason !== "No hay versión publicada") this.o.log(`Actualización: ${d.reason}`);
        this.updateMsg = d.reason === "Al día" || d.reason === "No hay versión publicada" ? "" : d.reason;
      } else if (d.action === "wait") {
        this.updateMsg = d.reason;
        next = UPDATE_WAIT_MS;
      } else {
        const url = resolveDownloadUrl(serverUrl, d.info.downloadUrl);
        if (!url) throw new Error("dirección de descarga no permitida");
        this.updateMsg = `Descargando versión ${d.info.version}…`;
        this.o.log(`Actualización: descargando ${d.info.version}`);
        const file = await downloadUpdate(url, d.info.sha256, updateDir(this.o.dir), d.info.version);
        if (this.bridge?.status().automation) {
          this.updateMsg = `Versión ${d.info.version} lista: se instala cuando termine la automatización`;
          next = UPDATE_WAIT_MS;
        } else {
          await this.install(file, d.info.version);
          return;
        }
      }
    } catch (e) {
      this.o.log(`Actualización: no pude comprobar/instalar (${(e as Error).message})`);
    } finally {
      this.updating = false;
    }
    this.scheduleUpdate(next);
  }

  private async install(file: string, version: string): Promise<void> {
    const exe = this.o.exePath;
    const undo = await swapExecutable(file, exe);
    try {
      const child = spawn(exe, ["--background", "--after-update"], { detached: true, stdio: "ignore", windowsHide: true });
      await new Promise<void>((ok, ko) => { child.once("spawn", ok); child.once("error", ko); });
      child.unref();
    } catch (e) {
      await undo().catch(() => undefined);
      throw e;
    }
    this.o.log(`Actualización: instalada ${version}; reiniciando`);
    await this.shutdown();
    await this.o.beforeRestart?.();
    process.exit(0);
  }
}
