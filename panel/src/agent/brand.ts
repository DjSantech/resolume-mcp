// Marca y valores de fábrica del agente. El nombre de la marca solo se escribe aquí.

/** Lo reemplaza esbuild al construir el .exe (variable VM_SERVER_URL). */
declare const __VM_SERVER_URL__: string | undefined;

export const BRAND_NAME = "VisualMaping";
/** Nombre del ejecutable publicado. */
export const EXE_NAME = `${BRAND_NAME}-Agente.exe`;
/** Servidor de fábrica; se puede cambiar en "Avanzado" de la página de vinculación. */
export const DEFAULT_SERVER_URL =
  (typeof __VM_SERVER_URL__ === "string" && __VM_SERVER_URL__) || "https://resolume-panel.onrender.com";
/** Puerto de la página local; también sirve de candado de instancia única. */
export const UI_PORT = 7377;
/** Resolume por defecto. VM_RESOLUME_URL lo cambia solo para desarrollo y pruebas. */
export const DEFAULT_RESOLUME_URL = "http://127.0.0.1:8080";
