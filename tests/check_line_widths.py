"""For every line: does the text shown in the editor fill the same width as the drawn line?"""
# usage: python tests/check_line_widths.py some.pdf
import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
from font_manager import FontManager
from pdf_engine import PdfEditor

fm = FontManager(); fm.ready.wait()
ed = PdfEditor(fm)
ed.open(open(sys.argv[1], "rb").read(), "t.pdf")
bad = 0
total = 0
for p in range(ed.doc.page_count):
    page = ed.doc[p]
    for ln in ed.lines(p)["lines"]:
        text = "".join(s["text"] for s in ln["spans"]).strip()
        if len(text) < 2:
            continue
        sp = ln["spans"][0]
        chain = ed.font_chain(page, sp["font"], sp["flags"])
        w = ed._measure(text, chain, sp["size"])
        c, s = ln["dir"][0], ln["dir"][1]
        b = ln["bbox"]
        v = [x * c + y * s for x in (b[0], b[2]) for y in (b[1], b[3])]
        drawn = max(v) - min(v)
        r = w / max(drawn, 1)
        total += 1
        flag = r < 0.85 or r > 1.15
        bad += flag
        if flag or "-v" in sys.argv:
            print("p%d %5.2f %s %r" % (p + 1, r, "!!" if flag else "  ", text[:80]))
print("lines", total, "width mismatches", bad)
