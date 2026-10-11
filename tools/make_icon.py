"""Draws the app icon (static/icon.png and build/icon.ico). Needs Pillow for the .ico."""
import io
import os

import pymupdf as fitz

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 256
doc = fitz.open()
page = doc.new_page(width=S, height=S)
blue, dark, white = (0.184, 0.42, 1.0), (0.12, 0.33, 0.88), (1, 1, 1)

# rounded blue tile
page.draw_rect(fitz.Rect(8, 8, 248, 248), color=None, fill=blue, radius=0.2)
# white sheet with a folded corner
sh = page.new_shape()
sh.draw_polyline([(74, 50), (150, 50), (186, 86), (186, 206), (74, 206), (74, 50)])
sh.finish(color=None, fill=white, closePath=True)
sh.draw_polyline([(150, 50), (186, 86), (150, 86), (150, 50)])
sh.finish(color=None, fill=(0.78, 0.85, 1.0), closePath=True)
# text lines
for y, w in ((112, 64), (132, 84), (152, 50)):
    sh.draw_rect(fitz.Rect(90, y, 90 + w, y + 9), radius=0.5)
    sh.finish(color=None, fill=(0.72, 0.79, 0.93))
# pencil
sh.draw_polyline([(196, 120), (220, 144), (150, 214), (120, 220), (126, 190), (196, 120)])
sh.finish(color=white, fill=dark, width=7, closePath=True, lineJoin=1)
sh.commit()

png = page.get_pixmap(alpha=True).tobytes("png")
with open(os.path.join(ROOT, "static", "icon.png"), "wb") as f:
    f.write(png)
try:
    from PIL import Image
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    Image.open(io.BytesIO(png)).save(os.path.join(ROOT, "build", "icon.ico"),
                                     sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
except ImportError:
    print("Pillow not installed: skipped icon.ico")
print("icon written")
