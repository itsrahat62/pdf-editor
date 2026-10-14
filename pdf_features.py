"""Acrobat-style tools: images, comments, text boxes, find & replace, pages,
watermark, header/footer, forms, protection and export."""
import datetime
import html as html_mod
import io
import re
from math import cos, radians, sin
import zipfile

import pymupdf as fitz

import textmap
from errors import EditError
from font_manager import FLAG_BOLD, FLAG_ITALIC, is_complex

ANNOT_NAMES = {
    fitz.PDF_ANNOT_TEXT: "note", fitz.PDF_ANNOT_HIGHLIGHT: "highlight", fitz.PDF_ANNOT_UNDERLINE: "underline",
    fitz.PDF_ANNOT_STRIKE_OUT: "strikeout", fitz.PDF_ANNOT_SQUIGGLY: "squiggly", fitz.PDF_ANNOT_SQUARE: "rectangle",
    fitz.PDF_ANNOT_CIRCLE: "ellipse", fitz.PDF_ANNOT_LINE: "line", fitz.PDF_ANNOT_INK: "drawing",
    fitz.PDF_ANNOT_FREE_TEXT: "text", fitz.PDF_ANNOT_STAMP: "stamp", fitz.PDF_ANNOT_POLYGON: "polygon",
    fitz.PDF_ANNOT_POLY_LINE: "polyline",
}


def _rgb(color):
    color = int(color or 0)
    return ((color >> 16) & 255) / 255.0, ((color >> 8) & 255) / 255.0, (color & 255) / 255.0


class FeaturesMixin:
    # ------------------------------------------------------------- helpers
    def forget_fonts(self):
        """Fonts were added; drop cached font look-ups."""
        self._emb_cache = {}

    def _change(self, fn):
        """Run fn() as one undoable change."""
        with self.lock:
            self._need()
            self._snapshot()
            try:
                result = fn()
            except EditError:
                self._rollback()
                raise
            except Exception as e:
                self._rollback()
                raise EditError(str(e) or e.__class__.__name__)
            self.version += 1
            return result

    def objects(self, pno):
        """Comments and form fields on a page."""
        with self.lock:
            self._need()
            page = self.doc[pno]
            annots = []
            for a in page.annots() or []:
                if a.type[0] in (fitz.PDF_ANNOT_LINK, fitz.PDF_ANNOT_WIDGET, fitz.PDF_ANNOT_POPUP):
                    continue
                annots.append({"xref": a.xref, "type": ANNOT_NAMES.get(a.type[0], a.type[1].lower()),
                               "rect": list(a.rect), "content": a.info.get("content", "")})
            widgets = []
            for w in page.widgets() or []:
                item = {"xref": w.xref, "name": w.field_name or "", "type": w.field_type_string,
                        "value": w.field_value, "rect": list(w.rect), "readonly": bool(w.field_flags & 1)}
                if w.field_type in (fitz.PDF_WIDGET_TYPE_COMBOBOX, fitz.PDF_WIDGET_TYPE_LISTBOX):
                    item["options"] = [o if isinstance(o, str) else o[1] for o in (w.choice_values or [])]
                if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON):
                    item["on"] = w.on_state()
                    item["checked"] = w.field_value not in (False, "Off", "", None)
                widgets.append(item)
            return {"annots": annots, "widgets": widgets}

    # --------------------------------------------------------------- images
    def insert_image(self, pno, rect, data):
        def run():
            self.doc[pno].insert_image(fitz.Rect(rect), stream=data, keep_proportion=True)
            return {"changed": True}
        return self._change(run)

    # ------------------------------------------------------------- comments
    def add_annot(self, pno, spec):
        def run():
            page = self.doc[pno]
            kind = spec["kind"]
            color = _rgb(spec.get("color", 0xFFD400))
            width = float(spec.get("width", 1.5))
            if kind in ("highlight", "underline", "strikeout", "squiggly"):
                r = fitz.Rect(spec["rect"])
                quads = []
                for w in page.get_text("words"):
                    wr = fitz.Rect(w[:4])
                    inter = wr & r
                    if not inter.is_empty and inter.get_area() > 0.3 * wr.get_area():
                        quads.append(wr.quad)
                if not quads:
                    quads = [r.quad]
                add = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
                       "strikeout": page.add_strikeout_annot, "squiggly": page.add_squiggly_annot}[kind]
                a = add(quads)
                a.set_colors(stroke=color)
            elif kind == "note":
                a = page.add_text_annot(fitz.Point(spec["point"]), spec.get("text", ""), icon="Comment")
                a.set_colors(stroke=color)
            elif kind in ("rectangle", "ellipse"):
                r = fitz.Rect(spec["rect"])
                a = page.add_rect_annot(r) if kind == "rectangle" else page.add_circle_annot(r)
                a.set_border(width=width)
                fill = spec.get("fill")
                a.set_colors(stroke=color, fill=_rgb(fill) if fill is not None else None)
            elif kind in ("line", "arrow"):
                a = page.add_line_annot(fitz.Point(spec["p1"]), fitz.Point(spec["p2"]))
                a.set_border(width=width)
                a.set_colors(stroke=color)
                if kind == "arrow":
                    a.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_OPEN_ARROW)
            elif kind == "drawing":
                paths = [[tuple(p) for p in path] for path in spec["paths"] if len(path) > 1]
                if not paths:
                    raise EditError("Nothing was drawn.")
                a = page.add_ink_annot(paths)
                a.set_border(width=width)
                a.set_colors(stroke=color)
            else:
                raise EditError("Unknown comment type: %s" % kind)
            if spec.get("opacity") is not None:
                a.set_opacity(float(spec["opacity"]))
            a.set_info(title=spec.get("author") or "PDF Editor")
            a.update()
            return {"changed": True}
        return self._change(run)

    def delete_annot(self, pno, xref):
        def run():
            page = self.doc[pno]
            for a in page.annots() or []:
                if a.xref == int(xref):
                    page.delete_annot(a)
                    return {"changed": True}
            raise EditError("That comment no longer exists.")
        return self._change(run)

    # ------------------------------------------------------------ text box
    def _font_css(self, page, family, bold, italic, text=""):
        flags = (FLAG_BOLD if bold else 0) | (FLAG_ITALIC if italic else 0)
        chain = self.font_chain(page, None, flags, {"family": family} if family else None)
        fc = next((f for f in chain if f.data and all(f.has(c) for c in text if c > " ")), None) or \
            next((f for f in chain if f.data), None)
        arch = fitz.Archive()
        if fc is None:
            return "", arch, "sans-serif"
        arch.add(fc.data, "f.ttf")
        return "@font-face{font-family:pf;src:url(f.ttf);}", arch, "pf"

    def add_textbox(self, pno, rect, text, family=None, bold=False, italic=False, size=12, color=0,
                    align="left", border=None, fill=None):
        def run():
            page = self.doc[pno]
            r = fitz.Rect(rect)
            face, arch, fam = self._font_css(page, family, bold, italic, text)
            if fill is not None:
                page.draw_rect(r, color=None, fill=_rgb(fill))
            if border is not None:
                page.draw_rect(r, color=_rgb(border), width=1)
            css = (face + "body{margin:0} p{margin:0;font-family:%s;font-size:%gpx;color:#%06x;"
                   "text-align:%s;line-height:1.25}" % (fam, float(size), int(color or 0), align))
            body = "".join("<p>%s</p>" % (html_mod.escape(ln) or "&#160;") for ln in text.split("\n"))
            pad = 3 if border is not None or fill is not None else 0
            inner = fitz.Rect(r.x0 + pad, r.y0 + pad, r.x1 - pad, r.y1 + 2000)
            before = page.get_contents()
            page.insert_htmlbox(inner, body, css=css, archive=arch, scale_low=1)
            if is_complex(text):
                textmap.wrap_new_contents(page, before, text)
            return {"changed": True}
        return self._change(run)

    # ------------------------------------------------------- find & replace
    def find(self, query, case=False):
        if not query:
            return []
        flags = 0 if case else re.I
        pat = re.compile(re.escape(query), flags)
        out = []
        with self.lock:
            self._need()
            for pno in range(self.doc.page_count):
                for ln in self.lines(pno)["lines"]:
                    text = "".join(s["text"] for s in ln["spans"])
                    n = len(pat.findall(text))
                    if n:
                        out.append({"page": pno, "bbox": ln["bbox"], "text": text, "count": n})
        return out

    def replace_all(self, query, repl, case=False):
        if not query:
            return {"count": 0}
        pat = re.compile(re.escape(query), 0 if case else re.I)

        def run():
            count = 0
            for pno in range(self.doc.page_count):
                done = []
                while True:
                    target = None
                    for ln in self.lines(pno)["lines"]:
                        text = "".join(s["text"] for s in ln["spans"])
                        key = [round(v) for v in ln["bbox"][:2]]
                        if pat.search(text) and key not in done:
                            target = ln
                            break
                    if target is None:
                        break
                    done.append([round(v) for v in target["bbox"][:2]])
                    segs = [{"src": i, "text": pat.sub(lambda m: repl, s["text"])}
                            for i, s in enumerate(target["spans"])]
                    if all(sg["text"] == s["text"] for sg, s in zip(segs, target["spans"])):
                        continue  # the match spans two styles; leave it
                    self.edit_line(pno, target, segs, snapshot=False)
                    count += 1
                    if count > 5000:
                        break
            return {"count": count}
        return self._change(run)

    # ---------------------------------------------------------------- pages
    def insert_blank(self, at, width=None, height=None):
        def run():
            ref = self.doc[min(max(at - 1, 0), self.doc.page_count - 1)].rect
            self.doc.new_page(pno=at, width=width or ref.width, height=height or ref.height)
            return {"changed": True}
        return self._change(run)

    def insert_pdf(self, at, data, password=None):
        def run():
            try:
                src = fitz.open("pdf", data)
            except Exception:
                raise EditError("That file is not a PDF.")
            if src.needs_pass and not src.authenticate(password or ""):
                raise EditError("PASSWORD_REQUIRED")
            n = src.page_count
            self.doc.insert_pdf(src, start_at=at)
            for p in range(at, at + n):
                page = self.doc[p]
                if page.rotation:
                    page.remove_rotation()
            return {"changed": True, "pages": n}
        return self._change(run)

    def insert_images(self, at, files):
        def run():
            n = 0
            for name, data in files:
                img = fitz.open(stream=data, filetype=name.rsplit(".", 1)[-1].lower())
                pdf = fitz.open("pdf", img.convert_to_pdf())
                self.doc.insert_pdf(pdf, start_at=at + n)
                n += pdf.page_count
            return {"changed": True, "pages": n}
        return self._change(run)

    def move_page(self, src, dst):
        def run():
            if src == dst:
                return {"changed": False}
            self.doc.move_page(src, dst if dst < self.doc.page_count else -1)
            return {"changed": True}
        return self._change(run)

    def duplicate_page(self, pno):
        def run():
            self.doc.fullcopy_page(pno, pno + 1 if pno + 1 < self.doc.page_count else -1)
            return {"changed": True}
        return self._change(run)

    def delete_pages(self, pages):
        def run():
            if len(set(pages)) >= self.doc.page_count:
                raise EditError("A PDF must keep at least one page.")
            self.doc.delete_pages(sorted(set(pages)))
            return {"changed": True}
        return self._change(run)

    def rotate_pages(self, pages, deg=90):
        point_types = (fitz.PDF_ANNOT_HIGHLIGHT, fitz.PDF_ANNOT_UNDERLINE, fitz.PDF_ANNOT_STRIKE_OUT,
                       fitz.PDF_ANNOT_SQUIGGLY, fitz.PDF_ANNOT_LINE, fitz.PDF_ANNOT_INK)

        def run():
            for p in pages:
                page = self.doc[p]
                page.set_rotation((page.rotation + deg) % 360)
                m = page.rotation_matrix
                # MuPDF cannot move these annotations itself; re-create them turned
                saved = []
                for a in list(page.annots() or []):
                    if a.type[0] in point_types:
                        saved.append((a.type[0], a.vertices, a.colors, a.border, a.info, a.opacity, a.line_ends))
                        page.delete_annot(a)
                page.remove_rotation()
                for kind, verts, colors, border, info, opacity, ends in saved:
                    if kind == fitz.PDF_ANNOT_INK:
                        a = page.add_ink_annot([[tuple(fitz.Point(pt) * m) for pt in path] for path in verts])
                    elif kind == fitz.PDF_ANNOT_LINE:
                        a = page.add_line_annot(fitz.Point(verts[0]) * m, fitz.Point(verts[1]) * m)
                        if ends:
                            a.set_line_ends(*ends)
                    else:
                        pts = [fitz.Point(pt) * m for pt in verts]
                        quads = [fitz.Quad(*pts[i:i + 4]) for i in range(0, len(pts) - 3, 4)]
                        add = {fitz.PDF_ANNOT_HIGHLIGHT: page.add_highlight_annot,
                               fitz.PDF_ANNOT_UNDERLINE: page.add_underline_annot,
                               fitz.PDF_ANNOT_STRIKE_OUT: page.add_strikeout_annot,
                               fitz.PDF_ANNOT_SQUIGGLY: page.add_squiggly_annot}[kind]
                        a = add(quads)
                    a.set_colors(stroke=colors.get("stroke"), fill=colors.get("fill"))
                    if border and border.get("width"):
                        a.set_border(width=border["width"])
                    if opacity is not None and opacity >= 0:
                        a.set_opacity(opacity)
                    a.set_info(info)
                    a.update()
            return {"changed": True}
        return self._change(run)

    def extract_pages(self, pages):
        with self.lock:
            self._need()
            new = fitz.open()
            for p in sorted(set(pages)):
                new.insert_pdf(self.doc, from_page=p, to_page=p)
            return new.tobytes(garbage=3, deflate=True)

    # ---------------------------------------------------- watermark / header
    def _pages(self, spec):
        n = self.doc.page_count
        if not spec or spec == "all":
            return list(range(n))
        out = set()
        for part in str(spec).replace(" ", "").split(","):
            if "-" in part:
                a, b = part.split("-", 1)
                out.update(range(max(1, int(a or 1)), min(n, int(b or n)) + 1))
            elif part:
                out.add(int(part))
        return sorted(p - 1 for p in out if 1 <= p <= n)

    def watermark(self, text, size=60, color=0x888888, opacity=0.25, angle=45, family=None, bold=True, pages="all"):
        if not text.strip():
            raise EditError("Type the watermark text.")

        def run():
            for pno in self._pages(pages):
                page = self.doc[pno]
                flags = FLAG_BOLD if bold else 0
                chain = self.font_chain(page, None, flags, {"family": family} if family else None)
                cx, cy = page.rect.width / 2, page.rect.height / 2
                if is_complex(text):
                    face, arch, fam = self._font_css(page, family, bold, False, text)
                    css = (face + "p{margin:0;font-family:%s;font-size:%gpx;color:#%06x;text-align:center}"
                           % (fam, float(size), int(color)))
                    r = fitz.Rect(0, cy - size, page.rect.width, cy + size * 1.5)
                    page.insert_htmlbox(r, "<p>%s</p>" % html_mod.escape(text), css=css, archive=arch,
                                        scale_low=0, opacity=float(opacity))
                    continue
                fc = next((f for f in chain if f.covers(text)), chain[0])
                w = fc.font.text_length(text, fontsize=size)
                tw = fitz.TextWriter(page.rect, opacity=float(opacity), color=_rgb(color))
                tw.append((cx - w / 2, cy + size * 0.35), text, font=fc.font, fontsize=size)
                a = radians(float(angle))
                c, s = cos(a), sin(a)
                tw.write_text(page, morph=(fitz.Point(cx, cy), fitz.Matrix(c, s, -s, c, 0, 0)))
            return {"changed": True}
        return self._change(run)

    def header_footer(self, text, position="bottom-center", size=10, color=0, family=None, margin=28,
                      start=1, pages="all"):
        if not text.strip():
            raise EditError("Type the header / footer text.")

        def run():
            sel = self._pages(pages)
            total = self.doc.page_count
            today = datetime.date.today().strftime("%d-%m-%Y")
            for pno in sel:
                page = self.doc[pno]
                t = (text.replace("{n}", str(pno + int(start))).replace("{total}", str(total))
                     .replace("{date}", today))
                chain = self.font_chain(page, None, 0, {"family": family} if family else None)
                w = self._measure(t, chain, size)
                vert, horiz = position.split("-")
                x = {"left": margin, "center": (page.rect.width - w) / 2, "right": page.rect.width - margin - w}[horiz]
                y = margin + size * 0.8 if vert == "top" else page.rect.height - margin
                self._write(page, x, y, t, chain, size, color, None, [])
            return {"changed": True}
        return self._change(run)

    # ------------------------------------------------------------- metadata
    def metadata(self):
        with self.lock:
            self._need()
            m = self.doc.metadata or {}
            return {k: m.get(k) or "" for k in ("title", "author", "subject", "keywords", "creator", "producer")}

    def set_metadata(self, values):
        def run():
            m = dict(self.doc.metadata or {})
            for k in ("title", "author", "subject", "keywords"):
                if k in values:
                    m[k] = values[k]
            self.doc.set_metadata(m)
            return {"changed": True}
        return self._change(run)

    # ---------------------------------------------------------------- forms
    def set_widget(self, pno, xref, value):
        def run():
            page = self.doc[pno]
            w = next((w for w in page.widgets() or [] if w.xref == int(xref)), None)
            if w is None:
                raise EditError("That form field no longer exists.")
            if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON):
                w.field_value = w.on_state() if value else "Off"
            else:
                w.field_value = "" if value is None else str(value)
            w.update()
            return {"changed": True}
        return self._change(run)

    def flatten_forms(self):
        def run():
            for page in self.doc:
                for w in list(page.widgets() or []):
                    w.update()
            self.doc.bake(annots=False, widgets=True)
            return {"changed": True}
        return self._change(run)

    # --------------------------------------------------------------- export
    def export_protected(self, password):
        data = self.export()
        if not password:
            return data
        d = fitz.open("pdf", data)
        return d.tobytes(garbage=3, deflate=True, encryption=fitz.PDF_ENCRYPT_AES_256,
                         owner_pw=password, user_pw=password,
                         permissions=int(fitz.PDF_PERM_ACCESSIBILITY | fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY |
                                         fitz.PDF_PERM_ANNOTATE | fitz.PDF_PERM_PRINT_HQ))

    def export_images(self, dpi=150, pages="all", fmt="png"):
        with self.lock:
            self._need()
            base = (self.name or "document").rsplit(".", 1)[0]
            bio = io.BytesIO()
            with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
                for pno in self._pages(pages):
                    pix = self.doc[pno].get_pixmap(dpi=int(dpi), alpha=False)
                    if fmt == "jpg":
                        z.writestr("%s-page-%d.jpg" % (base, pno + 1), pix.tobytes("jpg", jpg_quality=90))
                    else:
                        z.writestr("%s-page-%d.png" % (base, pno + 1), pix.tobytes("png"))
            return bio.getvalue()

    def open_images(self, files, name="images.pdf"):
        doc = fitz.open()
        for fname, data in files:
            try:
                img = fitz.open(stream=data, filetype=fname.rsplit(".", 1)[-1].lower())
                doc.insert_pdf(fitz.open("pdf", img.convert_to_pdf()))
            except Exception:
                raise EditError("Could not read %s as an image." % fname)
        if doc.page_count == 0:
            raise EditError("No images were given.")
        self.open(doc.tobytes(), name)

