"""Edit every line of every page, one at a time: the edited line must change,
no other line may change, and undo must restore everything exactly."""
# usage: python tests/check_each_line.py some.pdf
import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
from font_manager import FontManager
from pdf_engine import PdfEditor

fm = FontManager(); fm.ready.wait()
ed = PdfEditor(fm)
ed.open(open(sys.argv[1], "rb").read(), "t.pdf")


def snap(p):
    return [("".join(s["text"] for s in l["spans"]), [round(v) for v in l["bbox"]]) for l in ed.lines(p)["lines"]]


problems = 0
total = 0
for p in range(ed.doc.page_count):
    base = snap(p)
    st0 = ed.state()
    assert not st0["can_undo"], "document changed before any edit"
    for i in range(len(base)):
        line = ed.lines(p)["lines"][i]
        text = "".join(s["text"] for s in line["spans"])
        segs = [{"src": k, "text": s["text"]} for k, s in enumerate(line["spans"])]
        segs[-1]["text"] += " ১২3"
        try:
            ed.edit_line(p, line, segs)
        except Exception as e:
            print("FAIL edit", p, i, text[:40], e); problems += 1; continue
        total += 1
        after = snap(p)
        others_before = [t for k, (t, _) in enumerate(base) if k != i]
        texts_after = [t for t, _ in after]
        want = text + " ১২3"
        if want not in texts_after:
            print("NOT CHANGED/WRONG", p, i, repr(text[:50]), "->", [t for t in texts_after if t not in others_before][:3]); problems += 1
        missing = [t for t in others_before if t not in texts_after]
        if missing:
            print("NEIGHBOUR DAMAGED", p, i, repr(text[:40]), "lost:", [m[:40] for m in missing]); problems += 1
        ed.undo()
        if snap(p) != base:
            print("UNDO MISMATCH", p, i); problems += 1
    print("page", p + 1, "lines", len(base))
print("edits", total, "problems", problems)
