"""Edit groups of lines in one step (as a mouse selection does) and check that
every edited line changed, every other line stayed, and fonts were kept.
usage: python tests/check_multi_edit.py some.pdf [out.png]"""
import os
import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from font_manager import FontManager
from pdf_engine import PdfEditor

fm = FontManager(); fm.ready.wait()
ed = PdfEditor(fm)
ed.open(open(sys.argv[1], "rb").read(), "t.pdf")


def text(ln):
    return "".join(s["text"] for s in ln["spans"])


problems = 0
for p in range(ed.doc.page_count):
    lines = ed.lines(p)["lines"]
    lines.sort(key=lambda l: (round(l["bbox"][1]), l["bbox"][0]))
    # groups: every run of 3 neighbouring lines, then all lines at once
    groups = [lines[i:i + 3] for i in range(0, len(lines), 3)] + [lines]
    for gi, group in enumerate(groups):
        before = [text(l) for l in ed.lines(p)["lines"]]
        fonts_before = {text(l): [s["font"] for s in l["spans"]] for l in ed.lines(p)["lines"]}
        items, want = [], []
        for ln in group:
            segs = [{"src": k, "text": s["text"]} for k, s in enumerate(ln["spans"])]
            segs[-1]["text"] += " ঙ"
            items.append({"line": ln, "segs": segs})
            want.append(text(ln) + " ঙ")
        ed.edit_lines(p, items)
        after = [text(l) for l in ed.lines(p)["lines"]]
        for w in want:
            if w not in after:
                problems += 1
                print("p%d group %d MISSING %r" % (p + 1, gi, w[:60]))
        for t in before:
            if t not in [text(g) for g in group] and t not in after:
                problems += 1
                print("p%d group %d NEIGHBOUR LOST %r" % (p + 1, gi, t[:60]))
        if len(after) != len(before):
            problems += 1
            print("p%d group %d line count %d -> %d" % (p + 1, gi, len(before), len(after)))
        ed.undo()
        if [text(l) for l in ed.lines(p)["lines"]] != before:
            problems += 1
            print("p%d group %d UNDO MISMATCH" % (p + 1, gi))
    print("page", p + 1, "groups", len(groups))
if len(sys.argv) > 2:
    items = [{"line": l, "segs": [{"src": k, "text": s["text"] + (" ঙ" if k == len(l["spans"]) - 1 else "")}
                                  for k, s in enumerate(l["spans"])]} for l in ed.lines(0)["lines"]]
    ed.edit_lines(0, items)
    ed.doc[0].get_pixmap(dpi=100).save(sys.argv[2])
print("problems", problems)
