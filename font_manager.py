"""Font discovery and matching.

Builds an index of every font installed on the PC (plus bundled / user-added
fonts) and resolves the font names found inside a PDF to a real font file, so
edited text can be written back in the same typeface.
"""
import hashlib
import io
import json
import logging
import os
import re
import threading

import pymupdf as fitz
from fontTools.ttLib import TTCollection, TTFont

from paths import CACHE_DIR, USER_FONT_DIR, system_font_dirs

logging.getLogger("fontTools").setLevel(logging.CRITICAL)

FONT_EXTS = (".ttf", ".otf", ".ttc", ".otc")
INDEX_VERSION = 3

# PDF span flag bits (PyMuPDF)
FLAG_ITALIC = 2
FLAG_SERIF = 4
FLAG_MONO = 8
FLAG_BOLD = 16

# The 14 standard PDF fonts are never embedded; MuPDF ships exact stand-ins.
BASE14 = {
    "helvetica": "helv", "helveticabold": "hebo", "helveticaoblique": "heit",
    "helveticaboldoblique": "hebi", "timesroman": "tiro", "timesbold": "tibo",
    "timesitalic": "tiit", "timesbolditalic": "tibi", "courier": "cour",
    "courierbold": "cobo", "courieroblique": "coit", "courierboldoblique": "cobi",
    "symbol": "symb", "zapfdingbats": "zadb",
}

# Families that are close look-alikes when the real one is not installed.
ALIASES = {
    "helvetica": "arial", "helveticaneue": "arial", "helveticaneuelt": "arial",
    "nimbussans": "arial", "nimbussansl": "arial", "liberationsans": "arial",
    "arimo": "arial", "swiss": "arial", "sansserif": "arial",
    "times": "timesnewroman", "timesroman": "timesnewroman",
    "nimbusroman": "timesnewroman", "nimbusromanno9l": "timesnewroman",
    "liberationserif": "timesnewroman", "tinos": "timesnewroman",
    "courier": "couriernew", "nimbusmono": "couriernew", "nimbusmonol": "couriernew",
    "liberationmono": "couriernew", "cousine": "couriernew",
    "carlito": "calibri", "caladea": "cambria",
}

# Tried in order when the chosen font has no glyph for a typed character.
COVERAGE_FAMILIES = [
    "Nirmala UI", "Noto Sans Bengali", "Kalpurush", "SolaimanLipi", "Vrinda",
    "Segoe UI", "Arial", "Arial Unicode MS", "Segoe UI Symbol", "Segoe UI Historic",
    "Tahoma", "Microsoft Sans Serif", "Microsoft YaHei", "Malgun Gothic",
    "Yu Gothic", "MS Gothic", "SimSun", "Leelawadee UI", "Ebrima", "Gadugi",
    "Cambria Math", "Noto Sans",
]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def strip_subset(name):
    return re.sub(r"^[A-Z]{6}\+", "", name or "")


def _strip_style(n):
    prev = None
    while prev != n:
        prev = n
        n = re.sub(r"(bolditalic|boldoblique|bold|italic|oblique|regular|normal|psmt|mt|ps)$", "", n)
    return n


def is_complex(text):
    """True if the text needs OpenType shaping (Indic, Arabic, Hebrew, Thai ...)."""
    for ch in text:
        cp = ord(ch)
        if 0x0590 <= cp <= 0x109F or 0x1780 <= cp <= 0x17FF or 0xFB1D <= cp <= 0xFDFF or 0xFE70 <= cp <= 0xFEFF:
            return True
    return False


class FontChoice:
    """A concrete font that can be used to write text into a PDF."""

    def __init__(self, font, label, kind, data=None, family=None, bold=False, italic=False, cmap=None):
        self.font = font          # pymupdf.Font
        self.label = label        # human readable name
        self.kind = kind          # embedded | system | builtin | similar | substitute
        self.data = data          # raw font file bytes (None for builtin without buffer)
        self.family = family
        self.bold = bold
        self.italic = italic
        self._cmap = cmap         # optional set of codepoints (trusted unicode cmap)

    def has(self, ch):
        cp = ord(ch)
        if self._cmap is not None:
            return cp in self._cmap
        try:
            return self.font.has_glyph(cp) > 0
        except Exception:
            return False

    def covers(self, text):
        return all(self.has(c) for c in text if c >= " ")


class FontManager:
    def __init__(self):
        self.entries = []
        self.by_ps = {}
        self.by_full = {}
        self.by_family = {}
        self.display = {}
        self._choice_cache = {}
        self._lock = threading.RLock()
        self.ready = threading.Event()
        threading.Thread(target=self._build, daemon=True).start()

    # ---------------------------------------------------------------- index
    def _font_files(self):
        files = []
        for d in system_font_dirs():
            try:
                for fn in os.listdir(d):
                    if fn.lower().endswith(FONT_EXTS):
                        p = os.path.join(d, fn)
                        try:
                            st = os.stat(p)
                            files.append((p, int(st.st_mtime), st.st_size))
                        except OSError:
                            pass
            except OSError:
                pass
        files.sort()
        return files

    def _build(self):
        try:
            files = self._font_files()
            sig = hashlib.md5(json.dumps([INDEX_VERSION, files]).encode()).hexdigest()
            cache = os.path.join(CACHE_DIR, "font_index.json")
            entries = None
            try:
                with open(cache, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if saved.get("sig") == sig:
                    entries = saved["entries"]
            except Exception:
                entries = None
            if entries is None:
                entries = []
                for p, _, _ in files:
                    entries.extend(self._scan_file(p))
                try:
                    with open(cache, "w", encoding="utf-8") as f:
                        json.dump({"sig": sig, "entries": entries}, f)
                except OSError:
                    pass
            self._index(entries)
        finally:
            self.ready.set()

    def rebuild(self):
        self.ready.clear()
        self._build()

    @staticmethod
    def _read_face(tt, path, index):
        try:
            name = tt["name"]
            family = name.getDebugName(1)
            if not family or family[0] in ".@":
                return None
            sub = name.getDebugName(2) or "Regular"
            full = name.getDebugName(4) or (family + " " + sub)
            ps = name.getDebugName(6) or ""
            tfam = name.getDebugName(16) or family
            tsub = name.getDebugName(17) or sub
            bold = italic = False
            weight = 400
            if "OS/2" in tt:
                os2 = tt["OS/2"]
                weight = int(os2.usWeightClass)
                bold = bool(os2.fsSelection & 0x20)
                italic = bool(os2.fsSelection & 0x01)
            sl = sub.lower()
            bold = bold or "bold" in sl
            italic = italic or "italic" in sl or "oblique" in sl
            return {
                "path": path, "index": index, "family": family, "sub": sub, "full": full,
                "ps": ps, "tfam": tfam, "tsub": tsub, "bold": bold, "italic": italic,
                "weight": weight,
            }
        except Exception:
            return None

    def _scan_file(self, path):
        out = []
        try:
            if path.lower().endswith((".ttc", ".otc")):
                col = TTCollection(path, lazy=True)
                for i, tt in enumerate(col.fonts):
                    e = self._read_face(tt, path, i)
                    if e:
                        out.append(e)
                col.close()
            else:
                tt = TTFont(path, lazy=True, fontNumber=0)
                e = self._read_face(tt, path, 0)
                if e:
                    out.append(e)
                tt.close()
        except Exception:
            pass
        return out

    def _index(self, entries):
        by_ps, by_full, by_family, display = {}, {}, {}, {}
        for e in entries:
            if e["ps"]:
                by_ps.setdefault(norm(e["ps"]), e)
            by_full.setdefault(norm(e["full"]), e)
            by_full.setdefault(norm(e["tfam"] + e["tsub"]), e)
            by_family.setdefault(norm(e["family"]), []).append(e)
            display.setdefault(norm(e["family"]), e["family"])
        with self._lock:
            self.entries, self.by_ps, self.by_full = entries, by_ps, by_full
            self.by_family, self.display = by_family, display
            self._choice_cache = {}

    def families(self):
        self.ready.wait()
        return sorted(self.display.values(), key=lambda s: s.lower())

    # -------------------------------------------------------------- matching
    @staticmethod
    def _pick_style(faces, bold, italic):
        def score(e):
            s = 0
            s += 4 if e["bold"] == bold else 0
            s += 4 if e["italic"] == italic else 0
            s -= abs(e["weight"] - (700 if bold else 400)) / 1000.0
            return s
        return max(faces, key=score)

    def find_family(self, family, bold=False, italic=False):
        self.ready.wait()
        faces = self.by_family.get(norm(family))
        if not faces:
            e = self.by_full.get(norm(family)) or self.by_ps.get(norm(family))
            if not e:
                return None
            faces = self.by_family.get(norm(e["family"]), [e])
            bold = bold or e["bold"]
            italic = italic or e["italic"]
        return self._pick_style(faces, bold, italic)

    def find_pdf_name(self, pdfname, flags=0):
        """Resolve a PDF font name. Returns (entry, quality) or (None, None);
        quality is 'exact' (same typeface) or 'similar' (look-alike)."""
        self.ready.wait()
        base = strip_subset(pdfname)
        n = norm(base)
        if not n:
            return None, None
        e = self.by_ps.get(n) or self.by_full.get(n)
        if e:
            return e, "exact"
        low = base.lower()
        bold = bool(flags & FLAG_BOLD) or bool(re.search(r"bold|black|heavy", low))
        italic = bool(flags & FLAG_ITALIC) or bool(re.search(r"italic|oblique", low))
        fam = norm(re.split(r"[-,]", base)[0])
        cands = []
        for c in (fam, _strip_style(fam), _strip_style(n)):
            if c and c not in cands:
                cands.append(c)
        for c in cands:
            if c in self.by_family:
                return self._pick_style(self.by_family[c], bold, italic), "exact"
            e = self.by_full.get(c) or self.by_ps.get(c)
            if e:
                return self._pick_style(self.by_family.get(norm(e["family"]), [e]), bold or e["bold"], italic or e["italic"]), "exact"
        for c in cands:
            a = ALIASES.get(c)
            if a and a in self.by_family:
                return self._pick_style(self.by_family[a], bold, italic), "similar"
        # longest installed family that the PDF name starts with
        best = None
        for c in cands:
            for k in self.by_family:
                if len(k) >= 5 and c.startswith(k) and (best is None or len(k) > len(best)):
                    best = k
        if best:
            return self._pick_style(self.by_family[best], bold, italic), "similar"
        return None, None

    # --------------------------------------------------------------- loading
    @staticmethod
    def entry_bytes(entry):
        path = entry["path"]
        if path.lower().endswith((".ttc", ".otc")):
            key = hashlib.md5(("%s|%d|%d" % (path, entry["index"], os.path.getmtime(path))).encode()).hexdigest()
            out = os.path.join(CACHE_DIR, "face_%s.ttf" % key)
            if not os.path.exists(out):
                col = TTCollection(path)
                bio = io.BytesIO()
                col.fonts[entry["index"]].save(bio)
                col.close()
                with open(out, "wb") as f:
                    f.write(bio.getvalue())
            path = out
        with open(path, "rb") as f:
            return f.read()

    def choice(self, entry, kind="system"):
        key = (entry["path"], entry["index"], kind)
        with self._lock:
            fc = self._choice_cache.get(key)
            if fc is None:
                data = self.entry_bytes(entry)
                fc = FontChoice(fitz.Font(fontbuffer=data), entry["full"], kind, data,
                                entry["family"], entry["bold"], entry["italic"])
                self._choice_cache[key] = fc
            return fc

    def builtin(self, pdfname):
        code = BASE14.get(norm(strip_subset(pdfname)))
        if not code:
            return None
        key = ("builtin", code)
        with self._lock:
            fc = self._choice_cache.get(key)
            if fc is None:
                f = fitz.Font(code)
                try:
                    data = bytes(f.buffer)
                except Exception:
                    data = None
                fc = FontChoice(f, strip_subset(pdfname), "builtin", data, None, "b" in code[2:], "i" in code[2:])
                self._choice_cache[key] = fc
            return fc

    def by_family_choice(self, family, bold=False, italic=False, kind="system"):
        e = self.find_family(family, bold, italic)
        return self.choice(e, kind) if e else None

    def generic(self, flags=0, bold=None, italic=None):
        bold = bool(flags & FLAG_BOLD) if bold is None else bold
        italic = bool(flags & FLAG_ITALIC) if italic is None else italic
        fams = ["Courier New", "Consolas"] if flags & FLAG_MONO else (
            ["Times New Roman", "Georgia", "Cambria"] if flags & FLAG_SERIF else ["Arial", "Segoe UI", "Tahoma"])
        for fam in fams:
            fc = self.by_family_choice(fam, bold, italic, "substitute")
            if fc:
                return fc
        code = ("co" if flags & FLAG_MONO else "ti" if flags & FLAG_SERIF else "he")
        code += {(False, False): "ur" if code == "co" else "ro" if code == "ti" else "lv",
                 (True, False): "bo", (False, True): "it", (True, True): "bi"}[(bold, italic)]
        return FontChoice(fitz.Font(code), code, "substitute", None, None, bold, italic)

    def coverage_chain(self, bold=False, italic=False):
        out = []
        for fam in COVERAGE_FAMILIES:
            fc = self.by_family_choice(fam, bold, italic, "substitute")
            if fc:
                out.append(fc)
        return out

    # ------------------------------------------------------------ user fonts
    def add_font(self, filename, data):
        safe = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(filename))
        if not safe.lower().endswith(FONT_EXTS):
            raise ValueError("Only .ttf, .otf and .ttc font files are supported")
        fitz.Font(fontbuffer=data)  # validates
        with open(os.path.join(USER_FONT_DIR, safe), "wb") as f:
            f.write(data)
        self.rebuild()
        e = self._scan_file(os.path.join(USER_FONT_DIR, safe))
        return e[0]["family"] if e else safe
