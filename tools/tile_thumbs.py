"""Une las 4 miniaturas de cada render (name__0..3.png) en una hoja 4x1 y calcula las mismas estadísticas de color.
Uso: py -3 -I tile_thumbs.py <carpeta_raw> <carpeta_salida>
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

raw, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
groups = defaultdict(list)
for p in sorted(raw.glob("*__*.png")):
    groups[p.stem.rsplit("__", 1)[0]].append(p)

TW, TH = 320, 180
stats = {}
for name, files in groups.items():
    frames = [cv2.imread(str(f)) for f in sorted(files)]
    frames = [cv2.resize(f, (TW, TH)) for f in frames if f is not None]
    if not frames:
        continue
    sheet = np.hstack(frames)
    label = name + ".mov"
    cv2.putText(sheet, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(sheet, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out / f"{name}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])

    hsv = np.concatenate([cv2.cvtColor(f, cv2.COLOR_BGR2HSV).reshape(-1, 3) for f in frames])
    h, s, v = hsv[:, 0].astype(int), hsv[:, 1].astype(int), hsv[:, 2].astype(int)
    lit = v > 60
    yellow = lit & (s > 90) & (h >= 15) & (h <= 35)
    white = (v > 200) & (s < 40)
    colored = lit & (s > 90)
    hue_hist = np.bincount((h[colored] // 15).clip(0, 11), minlength=12) if colored.any() else np.zeros(12)
    motion = float(np.mean([np.mean(cv2.absdiff(frames[i], frames[i + 1])) for i in range(len(frames) - 1)])) if len(frames) > 1 else 0.0
    stats[label] = {
        "yellow_pct": round(float(100 * yellow.mean()), 1),
        "white_pct": round(float(100 * white.mean()), 1),
        "dark_pct": round(float(100 * (v < 40).mean()), 1),
        "saturated_pct": round(float(100 * colored.mean()), 1),
        "brightness": round(float(v.mean()), 1),
        "dominant_hues_deg": [int(i * 30) for i in np.argsort(hue_hist)[::-1][:3] if hue_hist[i] > 0],
        "frame_change": round(motion, 1),
    }

(out / "stats.json").write_text(json.dumps(stats, indent=1, ensure_ascii=False), encoding="utf-8")
print("hojas:", len(stats))
