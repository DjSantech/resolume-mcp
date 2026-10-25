"""Genera hojas de contacto (8 fotogramas) y estadísticas de color/movimiento de cada video.
Uso: py -3 -I contact_sheets.py <carpeta_videos> <carpeta_salida> <lista_nombres.txt>
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

src, out, names_file = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
names = [n.strip() for n in names_file.read_text(encoding="utf-8").splitlines() if n.strip()]

TW, TH = 320, 180
stats = {}
for name in names:
    path = src / name
    cap = cv2.VideoCapture(str(path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if not cap.isOpened() or n <= 0:
        img = cv2.imread(str(path))
        frames = [img] if img is not None else []
    else:
        frames = []
        for f in np.linspace(0.06, 0.94, 8):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(f * (n - 1)))
            ok, fr = cap.read()
            if ok:
                frames.append(fr)
    cap.release()
    if not frames:
        stats[name] = {"error": "no se pudo leer"}
        continue

    small = [cv2.resize(f, (TW, TH)) for f in frames]
    while len(small) < 8:
        small.append(np.zeros_like(small[0]))
    sheet = np.vstack([np.hstack(small[:4]), np.hstack(small[4:8])])
    cv2.putText(sheet, name, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(sheet, name, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out / (Path(name).stem + ".jpg")), sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])

    hsv = np.concatenate([cv2.cvtColor(f, cv2.COLOR_BGR2HSV).reshape(-1, 3) for f in small[: len(frames)]])
    h, s, v = hsv[:, 0].astype(int), hsv[:, 1].astype(int), hsv[:, 2].astype(int)
    lit = v > 60
    yellow = lit & (s > 90) & (h >= 15) & (h <= 35)  # amarillo/dorado (OpenCV H: 0-180)
    white = (v > 200) & (s < 40)
    dark = v < 40
    colored = lit & (s > 90)
    hue_hist = np.bincount((h[colored] // 15).clip(0, 11), minlength=12) if colored.any() else np.zeros(12)
    motion = float(np.mean([np.mean(cv2.absdiff(small[i], small[i + 1])) for i in range(len(frames) - 1)])) if len(frames) > 1 else 0.0
    stats[name] = {
        "yellow_pct": round(100 * yellow.mean(), 1),
        "white_pct": round(100 * white.mean(), 1),
        "dark_pct": round(100 * dark.mean(), 1),
        "saturated_pct": round(100 * colored.mean(), 1),
        "brightness": round(float(v.mean()), 1),
        "dominant_hues_deg": [int(i * 30) for i in np.argsort(hue_hist)[::-1][:3] if hue_hist[i] > 0],
        "frame_change": round(motion, 1),
    }
    print(name, stats[name], flush=True)

(out / "stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")
print("listo", len(stats))
