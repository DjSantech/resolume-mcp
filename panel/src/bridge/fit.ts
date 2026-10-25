// Ajusta un clip de video/imagen para que cuadre en la pantalla de la composición:
// proporción parecida a la composición (±10 %) → Fill (llena sin bordes); muy distinta → Fit (completa, con bordes).
// También deja la escala del Transform del clip en 100 %.
// Hay que hacerlo justo antes de cada lanzamiento: Resolume descarta estos cambios hechos por la API
// cuando se cambia de pestaña (deck).

import type { RClip, ResolumeApi } from "./resolume.js";

/** Qué resize le corresponde al clip, o null si no es un archivo (fuentes, Video Router, efectos). */
export function wantedResize(clip: RClip, compRatio: number): "Fill" | "Fit" | null {
  const fw = Number(clip.video?.fileinfo?.width), fh = Number(clip.video?.fileinfo?.height);
  if (!(fw > 0 && fh > 0)) return null;
  return Math.abs(fw / fh / compRatio - 1) <= 0.1 ? "Fill" : "Fit";
}

/** Aplica el ajuste a un clip ya leído (`GET /composition/clips/by-id/{id}`). Devuelve qué cambió, o null. */
export async function fitClip(api: ResolumeApi, clip: RClip, compRatio: number): Promise<string | null> {
  const want = wantedResize(clip, compRatio);
  if (!want) return null;
  const v = clip.video!;
  const changes: string[] = [];
  if (v.resize?.id !== undefined && v.resize.value !== want) {
    await api.call("PUT", `/parameter/by-id/${v.resize.id}`, { value: want });
    changes.push(want);
  }
  const scale = (v.effects ?? []).find((e) => e.name === "Transform")?.params?.Scale;
  if (scale?.id !== undefined && Math.abs(Number(scale.value) - 100) > 0.01) {
    await api.call("PUT", `/parameter/by-id/${scale.id}`, { value: 100 });
    changes.push("escala 100%");
  }
  return changes.length ? changes.join(", ") : null;
}

/** Proporción ancho/alto de la composición; 16:9 si no se conoce. */
export function ratioOf(width: number, height: number): number {
  return width > 0 && height > 0 ? width / height : 16 / 9;
}
