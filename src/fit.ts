// Ajusta un clip de video/imagen para que cuadre en la pantalla de la composición:
// proporción parecida a la composición → Fill (llena sin bordes); muy distinta → Fit (completa, con bordes).
// También deja la escala del Transform del clip en 100%.
// Hay que hacerlo justo antes de lanzar el clip: Resolume descarta estos cambios hechos por la API
// cuando se cambia de pestaña (deck).

export type Call = (method: "GET" | "PUT", path: string, body?: unknown) => Promise<unknown>;

type Param = { id?: number; value?: unknown } | undefined;
type ClipJson = {
  video?: {
    resize?: Param;
    fileinfo?: { width?: number; height?: number } | null;
    effects?: { name?: string; params?: { Scale?: Param } }[];
  };
};

let compRatio: number | undefined;

export async function fitClip(call: Call, clipId: number): Promise<string | null> {
  if (compRatio === undefined) {
    const comp = (await call("GET", "/composition")) as { video?: { width?: Param; height?: Param } };
    const w = Number(comp.video?.width?.value), h = Number(comp.video?.height?.value);
    compRatio = w > 0 && h > 0 ? w / h : 16 / 9;
  }
  const clip = (await call("GET", `/composition/clips/by-id/${clipId}`)) as ClipJson;
  const v = clip.video;
  const fw = v?.fileinfo?.width, fh = v?.fileinfo?.height;
  if (!v || !fw || !fh) return null; // fuentes generadas, efectos, Video Router: no se tocan

  const want = Math.abs(fw / fh / compRatio - 1) <= 0.1 ? "Fill" : "Fit";
  const changes: string[] = [];
  if (v.resize?.id !== undefined && v.resize.value !== want) {
    await call("PUT", `/parameter/by-id/${v.resize.id}`, { value: want });
    changes.push(want);
  }
  const scale = (v.effects ?? []).find((e) => e.name === "Transform")?.params?.Scale;
  if (scale?.id !== undefined && Math.abs(Number(scale.value) - 100) > 0.01) {
    await call("PUT", `/parameter/by-id/${scale.id}`, { value: 100 });
    changes.push("escala 100%");
  }
  return changes.length ? changes.join(", ") : null;
}
