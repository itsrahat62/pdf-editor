"""PDF editing engine built on PyMuPDF.

Text is edited line by line: the original glyphs are removed from the page
(a text-only redaction, so backgrounds and images stay intact) and the new
text is written back with the same font, size and colour.
"""
import difflib
import html as html_mod
import io
import math
import threading
import time

import pymupdf as fitz
from fontTools.ttLib import TTFont

import textmap
from errors import EditError
from pdf_features import FeaturesMixin
from font_manager import (FLAG_BOLD, FLAG_ITALIC, FontChoice, is_ansi_bangla, is_complex, norm,
                          strip_subset)

fitz.TOOLS.set_subset_fontnames(True)

MAX_UNDO = 30
BOOT_ID = "%x" % int(time.time() * 1000)
_MISSING = object()
TEXT_FLAGS = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES & ~fitz.TEXT_PRESERVE_LIGATURES
IGNORE_ACTUALTEXT = getattr(fitz, "TEXT_IGNORE_ACTUALTEXT", 2048)
ZERO_WIDTH = ("‌", "‍", "﻿")


def _rgb(color):
    color = int(color or 0)
    return ((color >> 16) & 255) / 255.0, ((color >> 8) & 255) / 255.0, (color & 255) / 255.0


def _clean(text):
    return (text or "").replace(" ", " ").replace("\r", "").replace("\n", " ")


class PdfEditor(FeaturesMixin):
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
            out = self._geom_lines(page)
            try:
                self._apply_fields(page, out)
            except Exception:
                pass
            info = {}
            for ln in out:
                for sp in ln["spans"]:
                    if is_ansi_bangla(sp["font"]) and not any("ঀ" <= c <= "৿" for c in sp["text"]):
                        sp["ansi"] = True
                    key = "%s|%d" % (sp["font"], sp["flags"])
                    if key not in info:
                        fc = self.font_chain(page, sp["font"], sp["flags"])[0]
                        info[key] = {"label": fc.label, "kind": fc.kind,
                                     "family": fc.family if fc.installed else None}
            return {"lines": out, "fonts": info}

    @staticmethod
    def _line_at(lines, x, y):
        best, area = None, None
        for i, ln in enumerate(lines):
            b = ln["bbox"]
            if b[0] - 1 <= x <= b[2] + 1 and b[1] - 1 <= y <= b[3] + 1:
                a = (b[2] - b[0]) * (b[3] - b[1])
                if area is None or a < area:
                    best, area = i, a
        return best

    def _apply_fields(self, page, lines):
        """Give lines drawn inside /ActualText spans their real Unicode text."""
        fields = textmap.page_fields(page)
        if not fields:
            return
        chars = []
        for b in page.get_text("rawdict", flags=TEXT_FLAGS)["blocks"]:
            for ln in b.get("lines", []):
                for s in ln["spans"]:
                    for c in s["chars"]:
                        if c["c"] in ZERO_WIDTH:
                            continue
                        x0, y0, x1, y1 = c["bbox"]
                        chars.append((c["c"], (x0 + x1) / 2, (y0 + y1) / 2))
        # whitespace is unreliable in MuPDF's ActualText output: match without it
        spos = [k for k, c in enumerate(chars) if not c[0].isspace()]
        sns = "".join(chars[k][0] for k in spos)

        # 1. find each field's characters; MuPDF puts them roughly on the field's glyphs
        found, owner, pos, claimed = [], {}, 0, set()

        def hits_of(match):
            where_, spans_ = [None] * len(ftext), {}
            for fk, sk in match:
                ch, cx, cy = chars[spos[sk]]
                hit = self._span_at(lines, cx, cy)
                if hit:
                    where_[fpos[fk]] = hit[0]
                    spans_.setdefault(hit[0], set()).add(hit[1])
            return where_, spans_

        for fi, (_, _, _, text) in enumerate(fields):
            ftext = text.replace("\r\n", "\n").replace("\r", "\n")
            # Avro and other keyboards add invisible joiners MuPDF drops when extracting
            ftext = "".join(ch for ch in ftext if ch not in ZERO_WIDTH)
            if not ftext.strip():
                continue
            fpos = [k for k, ch in enumerate(ftext) if not ch.isspace()]
            fns = "".join(ftext[k] for k in fpos)
            match = self._align(fns, sns, pos)
            if not match:
                continue
            where, spans_hit = hits_of(match)
            # a short field can also match inside a longer one: take an occurrence
            # whose glyphs no earlier field owns
            tries = 0
            while any((li, n) in claimed for li, ns in spans_hit.items() for n in ns) and tries < 40:
                tries += 1
                nxt = sns.find(fns, match[0][1] + 1)
                if nxt < 0:
                    break
                match = [(k, nxt + k) for k in range(len(fns))]
                where, spans_hit = hits_of(match)
            spans_hit = {li: {n for n in ns if (li, n) not in claimed} for li, ns in spans_hit.items()}
            spans_hit = {li: ns for li, ns in spans_hit.items() if ns}
            where = [w if w in spans_hit else None for w in where]
            pos = max(pos, match[-1][1] + 1)
            touched = sorted(spans_hit)
            if touched:
                found.append((fi, text, ftext, where, touched, spans_hit))
                for li in touched:
                    owner.setdefault(li, fi)
                    claimed.update((li, n) for n in spans_hit[li])

        # 2. add wrapped continuation lines that received no characters
        for fi, text, ftext, where, touched, spans_hit in found:
            ref = lines[max(touched)]
            left = lines[min(touched)]["bbox"][0]
            j = max(touched) + 1
            while j < len(lines) and j not in owner:
                ln = lines[j]
                h = ref["bbox"][3] - ref["bbox"][1]
                dy = ln["bbox"][1] - ref["bbox"][1]
                if (ln["spans"][0]["font"] != ref["spans"][0]["font"] or not 0.5 * h < dy < 2.2 * h
                        or abs(ln["bbox"][0] - left) > 60):
                    break
                touched.append(j)
                owner[j] = fi
                ref = ln
                j += 1

            # 3. split the field text over its lines
            order = sorted(touched, key=lambda i: (round(lines[i]["bbox"][1]), lines[i]["bbox"][0]))
            parts = [t.strip() for t in ftext.split("\n") if t.strip()]
            keep = None
            if len(parts) > len(order):
                # some generators draw part of a field a second time outside it;
                # a part that already is a line of its own is not drawn here
                loose = {"".join("".join(q["text"] for q in ln["spans"]).split())
                         for i, ln in enumerate(lines) if i not in owner}
                drawn = [k for k, t in enumerate(parts) if "".join(t.split()) not in loose]
                if len(drawn) == len(order):
                    keep = drawn
            if keep is not None:
                pieces = [parts[k] for k in keep]
            else:
                pieces = self._split_field(ftext, where, order, lines)
            if not pieces:
                continue
            for k, li in enumerate(order):
                ln = lines[li]
                hit = spans_hit.get(li) or set(range(len(ln["spans"])))
                # shaped scripts leave pieces (a pre-base vowel sign, ...) that got no
                # letter of their own; anything lying inside the field's extent is the field's
                dc, ds = ln["dir"][0], ln["dir"][1]

                def along(sp_):
                    b = sp_["bbox"]
                    v = [x * dc + y * ds for x in (b[0], b[2]) for y in (b[1], b[3])]
                    return min(v), max(v)
                hx0 = min(along(ln["spans"][n])[0] for n in hit)
                hx1 = max(along(ln["spans"][n])[1] for n in hit)
                for n, s in enumerate(ln["spans"]):
                    a0, a1 = along(s)
                    if min(a1, hx1) - max(a0, hx0) > 0.5 * max(a1 - a0, 0.01):
                        hit.add(n)
                mine = [s for n, s in enumerate(ln["spans"]) if n in hit]
                others = [s for n, s in enumerate(ln["spans"]) if n not in hit]
                sp0 = min(mine, key=lambda s: s["origin"][0] * dc + s["origin"][1] * ds)
                span = dict(sp0)
                span["text"] = pieces[k]
                if others and len(pieces) == 1:
                    # sharing a line with other text: keep the gap to the neighbour
                    span["text"] = ((" " if ftext[:1] == " " else "") + pieces[k] +
                                    (" " if ftext[-1:] == " " else ""))
                span["bbox"] = [min(s["bbox"][0] for s in mine), min(s["bbox"][1] for s in mine),
                                max(s["bbox"][2] for s in mine), max(s["bbox"][3] for s in mine)]
                span["boxes"] = [bx for s in mine for bx in s["boxes"]]
                span["field"] = True
                ln["spans"] = sorted(others + [span], key=lambda s: s["origin"][0] * dc + s["origin"][1] * ds)
                if keep is None:
                    rest = pieces[:k] + pieces[k + 1:]
                else:
                    rest = [t for n, t in enumerate(parts) if n != keep[k]]
                ln["field"] = {"index": fi, "text": text, "rest": "\n".join(rest)}

    @staticmethod
    def _align(fns, sns, pos):
        """Match the field letters (no spaces) to the extracted letters from `pos` on.
        Returns [(field index, stream index)] or None."""
        if not fns:
            return None
        start = sns.find(fns, pos)
        if start >= 0:
            return [(k, start + k) for k in range(len(fns))]
        # anchor on the first chunk that can be found, then align loosely
        anchor = -1
        for k in range(0, max(1, len(fns) - 4), max(1, len(fns) // 8)):
            chunk = fns[k:k + 5]
            at = sns.find(chunk, pos)
            if at >= 0:
                anchor = max(pos, at - k)
                break
        if anchor < 0:
            return None
        window = sns[anchor:anchor + int(len(fns) * 1.5) + 20]
        sm = difflib.SequenceMatcher(None, fns, window, autojunk=False)
        pairs = []
        for a, b, n in sm.get_matching_blocks():
            pairs.extend((a + d, anchor + b + d) for d in range(n))
        if len(pairs) < 0.6 * len(fns):
            return None
        return pairs

    @staticmethod
    def _span_at(lines, x, y):
        """(line index, span index) of the span drawn at a point."""
        best, area = None, None
        for i, ln in enumerate(lines):
            b = ln["bbox"]
            if not (b[0] - 1 <= x <= b[2] + 1 and b[1] - 1 <= y <= b[3] + 1):
                continue
            a = (b[2] - b[0]) * (b[3] - b[1])
            if area is not None and a >= area:
                continue
            k = 0
            dc, ds = ln["dir"][0], ln["dir"][1]
            p = x * dc + y * ds
            for n, s in enumerate(ln["spans"]):
                sb = s["bbox"]
                v = [bx * dc + by * ds for bx in (sb[0], sb[2]) for by in (sb[1], sb[3])]
                if min(v) - 1 <= p <= max(v) + 1:
                    k = n
                    break
            best, area = (i, k), a
        return best

    @staticmethod
    def _split_field(ftext, where, order, lines):
        """Split a field's text into one piece per drawn line."""
        n = len(order)
        parts = [t.strip() for t in ftext.split("\n") if t.strip()]
        if len(parts) == n:
            return parts
        # the glyph text is unreadable but keeps word gaps: match word counts
        counts = [len(" ".join(s["text"] for s in lines[i]["spans"]).split()) for i in order]
        words = ftext.split()
        if sum(counts) == len(words) and all(counts):
            out, k = [], 0
            for c in counts:
                out.append(" ".join(words[k:k + c]))
                k += c
            return out
        # otherwise: where did the characters land, snapped to word gaps
        starts = []
        for li in order:
            ks = [k for k, w in enumerate(where) if w == li]
            starts.append(min(ks) if ks else None)
        starts[0] = 0
        bounds = list(starts) + [len(ftext)]
        i = 0
        while i < n:                       # share text with lines that got no characters
            if bounds[i] is None:
                a = i - 1
                b = i
                while bounds[b] is None:
                    b += 1
                widths = [lines[order[k]]["bbox"][2] - lines[order[k]]["bbox"][0] for k in range(a, b)]
                total = sum(widths) or 1
                acc = 0
                for k in range(a, b - 1):
                    acc += widths[k - a]
                    bounds[k + 1] = int(bounds[a] + (bounds[b] - bounds[a]) * acc / total)
                i = b
            else:
                i += 1
        for k in range(1, n):
            b = bounds[k]
            best = None
            for d in range(0, 16):
                for cand in (b - d, b + d):
                    if bounds[k - 1] < cand < bounds[k + 1] and ftext[cand - 1].isspace() and not ftext[cand].isspace():
                        best = cand
                        break
                if best is not None:
                    break
            if best is not None:
                bounds[k] = best
        pieces = [ftext[bounds[k]:bounds[k + 1]].replace("\n", " ").strip() for k in range(n)]
        return pieces if all(pieces) else None

    def _geom_lines(self, page):
        """Text lines with their true glyph positions."""
        out = []
        for bno, block in enumerate(page.get_text("dict", flags=TEXT_FLAGS | IGNORE_ACTUALTEXT)["blocks"]):
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
                out.append({
                    "bbox": [min(sp["bbox"][0] for sp in spans), min(sp["bbox"][1] for sp in spans),
                             max(sp["bbox"][2] for sp in spans), max(sp["bbox"][3] for sp in spans)],
                    "dir": list(line["dir"]),
                    "spans": spans,
                    "block": bno,
                })
        return self._join_lines(out)

    @staticmethod
    def _join_lines(lines):
        """Shaped scripts (Bangla, ...) are drawn with glyphs out of order, which makes
        MuPDF cut one visual line into pieces. Put pieces that share a baseline and
        touch each other back together (in any writing direction)."""
        def extent(ln, c, s):
            b = ln["bbox"]
            vals = [x * c + y * s for x in (b[0], b[2]) for y in (b[1], b[3])]
            return min(vals), max(vals)

        out = []
        for ln in lines:
            sp = ln["spans"][0]
            c, s = ln["dir"][0], ln["dir"][1]
            for prev in out:
                psp = prev["spans"][0]
                if abs(prev["dir"][0] - c) > 1e-3 or abs(prev["dir"][1] - s) > 1e-3:
                    continue
                if abs(psp["size"] - sp["size"]) > 0.1:
                    continue
                perp_p = -psp["origin"][0] * s + psp["origin"][1] * c
                perp_c = -sp["origin"][0] * s + sp["origin"][1] * c
                if abs(perp_p - perp_c) > 0.6:
                    continue
                a0, a1 = extent(prev, c, s)
                b0, b1 = extent(ln, c, s)
                gap = 0.5 * sp["size"]
                if b0 < a1 + gap and a0 < b1 + gap:
                    pb, b = prev["bbox"], ln["bbox"]
                    prev["spans"] = sorted(prev["spans"] + ln["spans"],
                                           key=lambda q: q["origin"][0] * c + q["origin"][1] * s)
                    prev["bbox"] = [min(pb[0], b[0]), min(pb[1], b[1]), max(pb[2], b[2]), max(pb[3], b[3])]
                    break
            else:
                out.append(ln)
        return out

    def _runs(self, text, chain):
        """Split text into (text, font) runs, falling back per character."""
        runs = []
        cur = None
        for ch in text:
            if cur is not None and (ch.isspace() or not ch.isascii()) and cur.has(ch):
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
        before = page.get_contents()
        page.insert_htmlbox(box + (x - ox, y - oy, x - ox, y - oy), body, css=css, archive=arch, scale_low=1)
        # shaped glyphs do not map back to letters; record the real text with them
        textmap.wrap_new_contents(page, before, text)
        return x + (x1 - ox)

    def _write_shaped_turned(self, page, p, d, text, fc, size, color):
        """Shaped text along a turned baseline starting at p. Returns its length,
        or None for angles other than 90 / 180 / 270 degrees."""
        c, s = round(d[0]), round(d[1])
        if abs(d[0] - c) > 0.02 or abs(d[1] - s) > 0.02 or (c, s) == (1, 0):
            return None
        tmp = fitz.open()
        tp = tmp.new_page(width=9010, height=size * 4 + 60)
        end = self._write_shaped(tp, 10, size * 2, text, fc, size, color)
        y0 = y1 = None
        for b in tp.get_text("dict", flags=TEXT_FLAGS | IGNORE_ACTUALTEXT)["blocks"]:
            for ln in b.get("lines", []):
                y0 = ln["bbox"][1] if y0 is None else min(y0, ln["bbox"][1])
                y1 = ln["bbox"][3] if y1 is None else max(y1, ln["bbox"][3])
        if y0 is None:
            return 0.0
        w, asc, desc = end - 10, size * 2 - y0, y1 - size * 2
        clip = fitz.Rect(10, y0, end, y1)
        if (c, s) == (0, -1):      # reads upwards
            target, rot = fitz.Rect(p.x - asc, p.y - w, p.x + desc, p.y), 90
        elif (c, s) == (0, 1):     # reads downwards
            target, rot = fitz.Rect(p.x - desc, p.y, p.x + asc, p.y + w), -90
        else:                      # upside down
            target, rot = fitz.Rect(p.x - w, p.y - desc, p.x, p.y + asc), 180
        before = page.get_contents()
        page.show_pdf_page(target, tmp, 0, clip=clip, rotate=rot)
        textmap.wrap_new_contents(page, before, text)
        return w

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
            if is_complex(run_text) and fc.data:
                # turned text (90/180/270 degrees) still needs shaping
                o, m = morph
                c, s = m.a, -m.b
                p = fitz.Point(o.x + (x - o.x) * c, o.y + (x - o.x) * s)
                w = self._write_shaped_turned(page, p, (c, s), run_text, fc, size, color)
                if w is not None:
                    x += w
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

    def edit_line(self, pno, line, segs, ov=None, move=None, snapshot=True):
        """Replace the text of one line.

        line: the line object as returned by lines(); segs: [{src, text}] where src
        is the index of the original span whose style the text carries; ov: optional
        style override {family, bold, italic, size, color} for the whole line;
        move: optional (dx, dy) to shift the line.
        """
        with self.lock:
            self._need()
            page = self.doc[pno]
            ov = {k: v for k, v in (ov or {}).items() if v is not None and v != ""}
            dx, dy = (float(move[0]), float(move[1])) if move else (0.0, 0.0)
            force = bool(move)
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
                changed = bool(ov) or force or new != sp["text"]
                if straight and not changed and abs(shift) < 0.3:
                    continue
                if not straight and not plan and not changed and not any(
                        bool(ov) or force or by_src.get(j, "") != spans[j]["text"] for j in range(i, len(spans))):
                    continue
                plan.append([sp, new, changed])
                if straight:
                    chain = self.font_chain(page, sp["font"], sp["flags"], ov, sp["text"])
                    size = float(ov.get("size") or sp["size"])
                    plan[-1] += [chain, size, sp["origin"][0] + shift + dx]
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

            if snapshot:
                self._snapshot()
            try:
                for sp, _, _, _, _, _ in plan:
                    for box in sp["boxes"]:
                        page.add_redact_annot(self._redact_rect(box, horizontal), fill=False)
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                      graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                      text=fitz.PDF_REDACT_TEXT_REMOVE)
                field = line.get("field")
                if field and any(item[0].get("field") for item in plan):
                    # the line's words now live in the new text, not in the old field
                    self._set_field_text(page, field)
                elif not field:
                    # the same words may also sit in a field drawn elsewhere
                    self._drop_field_part(page, "".join(sp["text"] for sp in spans))
                report = []
                if straight:
                    for sp, new, _, chain, size, x in plan:
                        if new:
                            self._write(page, x, sp["origin"][1] + dy, new, chain, size,
                                        ov.get("color", sp["color"]), None, report)
                else:
                    ox, oy = spans[0]["origin"][0] + dx, spans[0]["origin"][1] + dy
                    morph = (fitz.Point(ox, oy), fitz.Matrix(c, -s, s, c, 0, 0))
                    x = ox
                    for sp, new, _, chain, size, _ in plan:
                        if new:
                            x = self._write(page, x, oy, new, chain, size,
                                            ov.get("color", sp["color"]), morph, report)
            except Exception as e:
                if snapshot:
                    self._rollback()
                raise EditError("Edit failed: %s" % e)
            self.version += 1
            return {"changed": True, "fonts": report}

    @staticmethod
    def _drop_field_part(page, text):
        key = "".join(text.split())
        if not key:
            return
        for i, f in enumerate(textmap.page_fields(page)):
            parts = f[3].replace("\r\n", "\n").split("\n")
            for k, p in enumerate(parts):
                if "".join(p.split()) == key and len([q for q in parts if q.strip()]) > 1:
                    textmap.set_field(page, i, "\n".join(parts[:k] + parts[k + 1:]))
                    return

    @staticmethod
    def _set_field_text(page, field):
        fields = textmap.page_fields(page)
        cands = [i for i, f in enumerate(fields) if f[3] == field["text"]]
        if cands:
            i = min(cands, key=lambda i: abs(i - field["index"]))
            textmap.set_field(page, i, field["rest"])

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
