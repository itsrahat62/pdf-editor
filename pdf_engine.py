"""PDF editing engine built on PyMuPDF.

Text is edited line by line: the original glyphs are removed from the page
(a text-only redaction, so backgrounds and images stay intact) and the new
text is written back with the same font, size and colour.
"""
import html as html_mod
import io
import math
import threading
import time

import pymupdf as fitz
from fontTools.ttLib import TTFont

from font_manager import (FLAG_BOLD, FLAG_ITALIC, FontChoice, is_complex, norm,
                          strip_subset)

fitz.TOOLS.set_subset_fontnames(True)

MAX_UNDO = 30
BOOT_ID = "%x" % int(time.time() * 1000)
_MISSING = object()
TEXT_FLAGS = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES & ~fitz.TEXT_PRESERVE_LIGATURES


class EditError(Exception):
    pass


def _rgb(color):
    color = int(color or 0)
    return ((color >> 16) & 255) / 255.0, ((color >> 8) & 255) / 255.0, (color & 255) / 255.0


def _clean(text):
    return (text or "").replace(" ", " ").replace("\r", "").replace("\n", " ")


class PdfEditor:
    def __init__(self, fonts):
        self.fm = fonts
        self.lock = threading.RLock()
        self.doc = None
        self.name = None
        self.version = 0
        self.undo_stack = []
        self.redo_stack = []
        self._emb_cache = {}

    # ------------------------------------------------------------- document
    def open(self, data, name, password=None):
        with self.lock:
            try:
                doc = fitz.open("pdf", data)
            except Exception:
                raise EditError("This file could not be opened as a PDF.")
            if doc.needs_pass:
                if not password:
                    raise EditError("PASSWORD_REQUIRED")
                if not doc.authenticate(password):
                    raise EditError("PASSWORD_WRONG")
                doc = fitz.open("pdf", doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE))
            if doc.page_count == 0:
                raise EditError("This PDF has no pages.")
            for page in doc:
                if page.rotation:
                    page.remove_rotation()
            self.doc = doc
            self.name = name or "document.pdf"
            self.undo_stack, self.redo_stack = [], []
            self._emb_cache = {}
            self.version += 1

    def _need(self):
        if self.doc is None:
            raise EditError("No PDF is open.")

    def state(self):
        with self.lock:
            if self.doc is None:
                return {"open": False}
            return {
                "open": True,
                "name": self.name,
                "version": self.version,
                "boot": BOOT_ID,
                "pages": [{"w": p.rect.width, "h": p.rect.height} for p in self.doc],
                "can_undo": bool(self.undo_stack),
                "can_redo": bool(self.redo_stack),
            }

    def render(self, pno, scale):
        with self.lock:
            self._need()
            scale = max(0.05, min(float(scale), 6.0))
            pix = self.doc[pno].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            return pix.tobytes("png")

    def export(self):
        with self.lock:
            self._need()
            raw = self.doc.tobytes()
            try:
                tmp = fitz.open("pdf", raw)
                n = tmp.page_count
                tmp.subset_fonts()
                out = tmp.tobytes(garbage=3, deflate=True)
                if fitz.open("pdf", out).page_count == n:
                    return out
            except Exception:
                pass
            return self.doc.tobytes(garbage=3, deflate=True)

    # ----------------------------------------------------------------- undo
    def _snapshot(self):
        self.undo_stack.append(self.doc.tobytes())
        if len(self.undo_stack) > MAX_UNDO:
            self.undo_stack.pop(0)
        self.redo_stack = []

    def _restore(self, data):
        self.doc = fitz.open("pdf", data)
        self._emb_cache = {}
        self.version += 1

    def _rollback(self):
        self._restore(self.undo_stack.pop())

    def undo(self):
        with self.lock:
            self._need()
            if self.undo_stack:
                self.redo_stack.append(self.doc.tobytes())
                self._restore(self.undo_stack.pop())

    def redo(self):
        with self.lock:
            self._need()
            if self.redo_stack:
                self.undo_stack.append(self.doc.tobytes())
                self._restore(self.redo_stack.pop())

    # ---------------------------------------------------------------- fonts
    def _embedded(self, page, fontname):
        """Fonts embedded in the PDF under this name that are usable for new text."""
        out = []
        want = norm(strip_subset(fontname))
        for f in page.get_fonts(full=True):
            xref, ext, basefont = f[0], f[1], f[3]
            if basefont != fontname and norm(strip_subset(basefont)) != want:
                continue
            fc = self._emb_cache.get(xref, _MISSING)
            if fc is _MISSING:
                fc = None
                if ext and ext != "n/a":
                    try:
                        buf = self.doc.extract_font(xref)[3]
                        if buf:
                            cmap = None
                            if buf[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                                # Subset fonts often carry no usable Unicode cmap;
                                # those cannot be trusted for typing new text.
                                best = TTFont(io.BytesIO(buf), lazy=True).getBestCmap()
                                if not best:
                                    raise ValueError("no unicode cmap")
                                cmap = set(best.keys())
                            fc = FontChoice(fitz.Font(fontbuffer=buf), strip_subset(basefont),
                                            "embedded", buf, cmap=cmap)
                    except Exception:
                        fc = None
                self._emb_cache[xref] = fc
            if fc is not None:
                out.append((basefont == fontname, fc))
        out.sort(key=lambda t: not t[0])
        return [fc for _, fc in out]

    def _builtin_styled(self, fontname, bold, italic):
        n = norm(strip_subset(fontname))
        for base, names in (("helvetica", ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique")),
                            ("times", ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic")),
                            ("courier", ("Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"))):
            if n.startswith(base) and self.fm.builtin(fontname):
                return self.fm.builtin(names[(1 if bold else 0) + (2 if italic else 0)])
        return None

    def font_chain(self, page, fontname, flags, ov=None, orig_text=""):
        """Ordered list of fonts to try for a span; the first one is preferred."""
        ov = ov or {}
        flags = int(flags or 0)
        obold, oitalic = bool(flags & FLAG_BOLD), bool(flags & FLAG_ITALIC)
        bold = bool(ov["bold"]) if ov.get("bold") is not None else obold
        italic = bool(ov["italic"]) if ov.get("italic") is not None else oitalic
        chain = []
        if ov.get("family"):
            fc = self.fm.by_family_choice(ov["family"], bold, italic)
            if fc:
                chain.append(fc)
        elif (bold, italic) == (obold, oitalic):
            if fontname:
                for fc in self._embedded(page, fontname):
                    if all(fc.has(c) for c in orig_text if not c.isspace()):
                        chain.append(fc)
                if not chain:
                    b = self.fm.builtin(fontname)
                    if b:
                        chain.append(b)
                e, q = self.fm.find_pdf_name(fontname, flags)
                if e:
                    chain.append(self.fm.choice(e, "system" if q == "exact" else "similar"))
        elif fontname:
            b = self._builtin_styled(fontname, bold, italic)
            if b:
                chain.append(b)
            else:
                e, q = self.fm.find_pdf_name(fontname, flags)
                if e:
                    e2 = self.fm.find_family(e["family"], bold, italic)
                    chain.append(self.fm.choice(e2 or e, "system" if q == "exact" else "similar"))
        chain.append(self.fm.generic(flags, bold, italic))
        chain.extend(self.fm.coverage_chain(bold, italic))
        return chain

    def font_info(self, pno, fontname, flags):
        with self.lock:
            self._need()
            fc = self.font_chain(self.doc[pno], fontname, flags)[0]
            return {"label": fc.label, "kind": fc.kind}

    def font_face_bytes(self, pno, fontname, flags, ov=None):
        """Font file for previewing in the UI while typing."""
        with self.lock:
            self._need()
            for fc in self.font_chain(self.doc[pno], fontname, flags, ov):
                if fc.data and fc.data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                    return fc.data
                if fc.kind != "embedded":
                    break
            return None

    # ----------------------------------------------------------------- text
    def lines(self, pno):
        with self.lock:
            self._need()
            page = self.doc[pno]
            out, info = [], {}
            for block in page.get_text("dict", flags=TEXT_FLAGS)["blocks"]:
                for line in block.get("lines", []):
                    spans = []
                    for s in line["spans"]:
                        text = s["text"].replace(" ", " ").replace("­", "-")
                        if not text:
                            continue
                        prev = spans[-1] if spans else None
                        if (prev and prev["font"] == s["font"] and abs(prev["size"] - s["size"]) < 0.05
                                and prev["color"] == s["color"] and prev["flags"] == s["flags"]
                                and abs(prev["origin"][1] - s["origin"][1]) < 0.5
                                and s["origin"][0] >= prev["origin"][0] - 0.5):
                            prev["text"] += text
                            prev["boxes"].append(list(s["bbox"]))
                            b = prev["bbox"]
                            prev["bbox"] = [min(b[0], s["bbox"][0]), min(b[1], s["bbox"][1]),
                                            max(b[2], s["bbox"][2]), max(b[3], s["bbox"][3])]
                            continue
                        spans.append({
                            "text": text, "font": s["font"], "name": strip_subset(s["font"]),
                            "size": round(s["size"], 3), "color": s["color"], "flags": s["flags"],
                            "bbox": list(s["bbox"]), "boxes": [list(s["bbox"])],
                            "origin": list(s["origin"]),
                        })
                    if not spans or not any(sp["text"].strip() for sp in spans):
                        continue
                    for sp in spans:
                        key = "%s|%d" % (sp["font"], sp["flags"])
                        if key not in info:
                            fc = self.font_chain(page, sp["font"], sp["flags"])[0]
                            info[key] = {"label": fc.label, "kind": fc.kind}
                    out.append({
                        "bbox": [min(sp["bbox"][0] for sp in spans), min(sp["bbox"][1] for sp in spans),
                                 max(sp["bbox"][2] for sp in spans), max(sp["bbox"][3] for sp in spans)],
                        "dir": list(line["dir"]),
                        "spans": spans,
                    })
            return {"lines": out, "fonts": info}

    def _runs(self, text, chain):
        """Split text into (text, font) runs, falling back per character."""
        runs = []
        cur = None
        for ch in text:
            if cur is not None and ch.isspace() and cur.has(ch):
                fc = cur
            else:
                fc = next((c for c in chain if c.has(ch)), chain[0])
            if fc is cur:
                runs[-1][0] += ch
            else:
                runs.append([ch, fc])
                cur = fc
        return runs

    def _write_shaped(self, page, x, y, text, fc, size, color):
        """Write text that needs OpenType shaping (Bangla, Arabic, ...). Returns end x."""
        arch = fitz.Archive()
        arch.add(fc.data, "f.ttf")
        css = ("@font-face{font-family:pf;src:url(f.ttf);} body{margin:0} "
               "p{margin:0;font-family:pf;font-size:%gpx;color:#%06x;white-space:nowrap}" % (size, int(color or 0)))
        body = "<p>%s</p>" % html_mod.escape(text).replace(" ", "&#160;")
        h = size * 4 + 40
        box = fitz.Rect(10, 10, 9000, 10 + h)
        tmp = fitz.open()
        tp = tmp.new_page(width=9010, height=h + 20)
        tp.insert_htmlbox(box, body, css=css, archive=arch, scale_low=1)
        ox = oy = x1 = None
        for b in tp.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                for sp in ln["spans"]:
                    if ox is None:
                        ox, oy = sp["origin"]
                    x1 = max(x1 or 0, sp["bbox"][2])
                    ox = min(ox, sp["bbox"][0])
        tmp.close()
        if ox is None:
            return x
        page.insert_htmlbox(box + (x - ox, y - oy, x - ox, y - oy), body, css=css, archive=arch, scale_low=1)
        return x + (x1 - ox)

    def _write(self, page, x, y, text, chain, size, color, morph=None, report=None):
        """Write text starting at baseline point (x, y). Returns end x."""
        for run_text, fc in self._runs(text, chain):
            if report is not None and run_text.strip():
                item = {"label": fc.label, "kind": fc.kind}
                if item not in report:
                    report.append(item)
            if is_complex(run_text) and fc.data and morph is None:
                x = self._write_shaped(page, x, y, run_text, fc, size, color)
                continue
            tw = fitz.TextWriter(page.rect, color=_rgb(color))
            _, last = tw.append((x, y), run_text, font=fc.font, fontsize=size)
            tw.write_text(page, morph=morph)
            x = last.x
        return x

    @staticmethod
    def _redact_rect(box, horizontal):
        x0, y0, x1, y1 = box
        if horizontal:
            mid, h = (y0 + y1) / 2, (y1 - y0)
            dx = min(0.4, (x1 - x0) * 0.1)
            return fitz.Rect(x0 + dx, mid - h * 0.08, x1 - dx, mid + h * 0.08)
        mid, w = (x0 + x1) / 2, (x1 - x0)
        dy = min(0.4, (y1 - y0) * 0.1)
        return fitz.Rect(mid - w * 0.08, y0 + dy, mid + w * 0.08, y1 - dy)

    def edit_line(self, pno, line, segs, ov=None):
        """Replace the text of one line.

        line: the line object as returned by lines(); segs: [{src, text}] where src
        is the index of the original span whose style the text carries; ov: optional
        style override {family, bold, italic, size, color} for the whole line.
        """
        with self.lock:
            self._need()
            page = self.doc[pno]
            ov = {k: v for k, v in (ov or {}).items() if v is not None and v != ""}
            spans = line["spans"]
            c, s = line.get("dir", [1, 0])[:2]
            horizontal = abs(c) >= abs(s)
            straight = abs(c - 1) < 1e-3 and abs(s) < 1e-3
            by_src = {}
            for seg in segs:
                i = min(max(int(seg.get("src", 0)), 0), len(spans) - 1)
                by_src[i] = by_src.get(i, "") + _clean(seg.get("text"))

            # Decide what must be rewritten. On a normal horizontal line, untouched
            # spans before the first change keep their original glyphs.
            plan = []          # (span, new_text, start_x)
            shift = 0.0
            for i, sp in enumerate(spans):
                new = by_src.get(i, "")
                changed = bool(ov) or new != sp["text"]
                if straight and not changed and abs(shift) < 0.3:
                    continue
                if not straight and not plan and not changed and not any(
                        bool(ov) or by_src.get(j, "") != spans[j]["text"] for j in range(i, len(spans))):
                    continue
                plan.append([sp, new, changed])
                if straight:
                    chain = self.font_chain(page, sp["font"], sp["flags"], ov, sp["text"])
                    size = float(ov.get("size") or sp["size"])
                    plan[-1] += [chain, size, sp["origin"][0] + shift]
                    if changed:
                        shift += self._measure(new, chain, size) - (sp["bbox"][2] - sp["bbox"][0])
            if not plan:
                return {"changed": False, "fonts": []}
            if not straight:
                # rotated text: rewrite the whole line from its origin
                plan = [[sp, by_src.get(i, ""), True] for i, sp in enumerate(spans)]
                for item in plan:
                    sp = item[0]
                    item += [self.font_chain(page, sp["font"], sp["flags"], ov, sp["text"]),
                             float(ov.get("size") or sp["size"]), None]

            self._snapshot()
            try:
                for sp, _, _, _, _, _ in plan:
                    for box in sp["boxes"]:
                        page.add_redact_annot(self._redact_rect(box, horizontal), fill=False)
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                      graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                      text=fitz.PDF_REDACT_TEXT_REMOVE)
                report = []
                if straight:
                    for sp, new, _, chain, size, x in plan:
                        if new:
                            self._write(page, x, sp["origin"][1], new, chain, size,
                                        ov.get("color", sp["color"]), None, report)
                else:
                    ox, oy = spans[0]["origin"]
                    morph = (fitz.Point(ox, oy), fitz.Matrix(c, -s, s, c, 0, 0))
                    x = ox
                    for sp, new, _, chain, size, _ in plan:
                        if new:
                            x = self._write(page, x, oy, new, chain, size,
                                            ov.get("color", sp["color"]), morph, report)
            except Exception as e:
                self._rollback()
                raise EditError("Edit failed: %s" % e)
            self.version += 1
            return {"changed": True, "fonts": report}

    def _measure(self, text, chain, size):
        w = 0.0
        for run_text, fc in self._runs(text, chain):
            if is_complex(run_text) and fc.data:
                tmp = fitz.open()
                tp = tmp.new_page(width=9010, height=size * 4 + 60)
                w += self._write_shaped(tp, 10, size * 2, run_text, fc, size, 0) - 10
                tmp.close()
            else:
                w += fc.font.text_length(run_text, fontsize=size)
        return w

    def add_text(self, pno, x, y_top, text, family=None, bold=False, italic=False, size=12, color=0):
        with self.lock:
            self._need()
            page = self.doc[pno]
            text = (text or "").replace("\r", "").replace(" ", " ")
            if not text.strip():
                return {"changed": False, "fonts": []}
            size = max(1.0, float(size or 12))
            chain = self.font_chain(page, None, (FLAG_BOLD if bold else 0) | (FLAG_ITALIC if italic else 0),
                                    {"family": family} if family else None)
            asc = chain[0].font.ascender or 0.9
            self._snapshot()
            try:
                report = []
                for i, ln in enumerate(text.split("\n")):
                    if ln:
                        self._write(page, float(x), float(y_top) + asc * size + i * size * 1.2, ln,
                                    chain, size, color, None, report)
            except Exception as e:
                self._rollback()
                raise EditError("Could not add text: %s" % e)
            self.version += 1
            return {"changed": True, "fonts": report}

    def erase(self, pno, rect, color=0xFFFFFF):
        """Blank out an area (removes the text/images under it and paints it over)."""
        with self.lock:
            self._need()
            page = self.doc[pno]
            r = fitz.Rect(rect) & page.rect
            r.normalize()
            if r.is_empty or r.width < 1 or r.height < 1:
                return {"changed": False}
            self._snapshot()
            try:
                page.add_redact_annot(r, fill=_rgb(color))
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS,
                                      graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                      text=fitz.PDF_REDACT_TEXT_REMOVE)
            except Exception as e:
                self._rollback()
                raise EditError("Erase failed: %s" % e)
            self.version += 1
            return {"changed": True}

    def delete_page(self, pno):
        with self.lock:
            self._need()
            if self.doc.page_count <= 1:
                raise EditError("A PDF must keep at least one page.")
            self._snapshot()
            self.doc.delete_page(pno)
            self.version += 1

    def rotate_page(self, pno, deg=90):
        with self.lock:
            self._need()
            self._snapshot()
            page = self.doc[pno]
            page.set_rotation((page.rotation + deg) % 360)
            page.remove_rotation()
            self.version += 1
