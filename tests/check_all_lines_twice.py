"""Edit every line twice, keeping all edits; check every line at the end."""
# usage: python tests/check_all_lines_twice.py some.pdf out.png
import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
from font_manager import FontManager
from pdf_engine import PdfEditor

fm = FontManager(); fm.ready.wait()
ed = PdfEditor(fm)
ed.open(open(sys.argv[1], "rb").read(), "t.pdf")
out = sys.argv[2]


def texts(p):
    return ["".join(s["text"] for s in l["spans"]) for l in ed.lines(p)["lines"]]


problems = 0
for p in range(ed.doc.page_count):
    expected = list(texts(p))
    for rnd, mark in ((1, " ক১"), (2, " খ২")):
        for i in range(len(expected)):
            cur = texts(p)
            src = expected[i]
            if src not in cur:
                print("LOST before edit", p, rnd, repr(src[:50])); problems += 1; continue
            j = cur.index(src)
            line = ed.lines(p)["lines"][j]
            segs = [{"src": k, "text": s["text"]} for k, s in enumerate(line["spans"])]
            segs[-1]["text"] += mark
            ed.edit_line(p, line, segs)
            expected[i] = src + mark
    final = texts(p)
    for e in expected:
        if e not in final:
            near = [f for f in final if f[:12] == e[:12]]
            print("MISSING", p, repr(e[:60]), "| near:", [n[:70] for n in near]); problems += 1
    extra = [f for f in final if f not in expected]
    if extra:
        print("EXTRA lines", p, [x[:50] for x in extra]); problems += 1
    print("page", p + 1, "lines", len(expected), "final", len(final))
ed.doc[0].get_pixmap(dpi=110).save(out)
print("problems", problems)
