"""Builds tests/sample.pdf: a small document using several fonts, for trying the editor."""
import os
import sys

import pymupdf as fitz

F = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "sample.pdf")


def font(fn, fallback):
    p = os.path.join(F, fn)
    return fitz.Font(fontfile=p) if os.path.exists(p) else fitz.Font(fallback)


doc = fitz.open()
page = doc.new_page()
page.draw_rect(fitz.Rect(0, 0, 595, 90), fill=(0.12, 0.25, 0.55), color=None)
page.draw_rect(fitz.Rect(60, 395, 535, 445), fill=(1, 0.95, 0.75), color=None)

rows = [
    (72, 58, "Invoice No. 2026-0417", font("georgiab.ttf", "tibo"), 26, (1, 1, 1)),
    (72, 130, "Customer name: Rahim Uddin", font("calibri.ttf", "helv"), 14, (0, 0, 0)),
    (72, 152, "Address: 12 Lake Road, Dhaka 1207", font("calibri.ttf", "helv"), 14, (0, 0, 0)),
    (72, 190, "This paragraph is set in Times New Roman at eleven points.", font("times.ttf", "tiro"), 11, (0, 0, 0)),
    (72, 204, "A second line sits tightly under the first one, like body text.", font("times.ttf", "tiro"), 11, (0, 0, 0)),
    (72, 240, "Verdana italic line in a dark red colour", font("verdanai.ttf", "heit"), 12, (0.6, 0.05, 0.05)),
    (72, 270, "Consolas: total = price * qty;", font("consola.ttf", "cour"), 12, (0.1, 0.1, 0.1)),
    (72, 300, "Segoe UI Semibold heading", font("seguisb.ttf", "hebo"), 16, (0.1, 0.4, 0.2)),
    (72, 425, "Text on a coloured background: Total 4,500 BDT", font("arialbd.ttf", "hebo"), 13, (0.3, 0.2, 0)),
]
for x, y, text, f, size, color in rows:
    tw = fitz.TextWriter(page.rect, color=color)
    tw.append((x, y), text, font=f, fontsize=size)
    tw.write_text(page)

# one line with mixed styles
x = 72
for text, f in (("Mixed line: ", font("arial.ttf", "helv")), ("bold words", font("arialbd.ttf", "hebo")),
                (" and ", font("arial.ttf", "helv")), ("italic words", font("ariali.ttf", "heit")),
                (" together.", font("arial.ttf", "helv"))):
    tw = fitz.TextWriter(page.rect)
    _, last = tw.append((x, 340), text, font=f, fontsize=12)
    tw.write_text(page)
    x = last.x

page.insert_text((72, 480), "Standard Helvetica (not embedded in the PDF)", fontname="helv", fontsize=12)
page.insert_text((72, 500), "Standard Times Bold (not embedded)", fontname="tibo", fontsize=12)
tw = fitz.TextWriter(page.rect)
tw.append((560, 700), "Rotated text", font=font("arial.ttf", "helv"), fontsize=12)
tw.write_text(page, morph=(fitz.Point(560, 700), fitz.Matrix(0, 1, -1, 0, 0, 0)))

p2 = doc.new_page()
tw = fitz.TextWriter(p2.rect)
tw.append((72, 100), "Second page, Cambria.", font=font("cambria.ttc", "tiro"), fontsize=18)
tw.write_text(p2)

doc.subset_fonts()
doc.save(out, garbage=3, deflate=True)
print("wrote", out)
