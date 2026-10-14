"""Downloading fonts that are not installed.

Sources: the free Bangla fonts collected in github.com/hmoazzem/bangla-fonts
(Nikosh, SolaimanLipi, Kalpurush, ...) and the Google Fonts library
(github.com/google/fonts, ~1,800 open-source families).
"""
import io
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request

from fontTools.ttLib import TTFont

from font_manager import norm, strip_subset, _strip_style
from paths import CACHE_DIR, USER_FONT_DIR

BANGLA_BASE = "https://raw.githubusercontent.com/hmoazzem/bangla-fonts/master/"
BANGLA = {
    "Nikosh": ["Nikosh.ttf"],
    "NikoshBAN": ["NikoshBAN.ttf"],
    "NikoshGrameen": ["NikoshGrameen.ttf"],
    "NikoshLightBAN": ["NikoshLightBan.ttf"],
    "SolaimanLipi": ["SolaimanLipi_20-04-07.ttf"],
    "Kalpurush": ["kalpurush.ttf"],
    "Kalpurush ANSI": ["kalpurush ANSI.ttf"],
    "Siyam Rupali": ["Siyamrupali.ttf"],
    "Siyam Rupali ANSI": ["Siyam Rupali ANSI.ttf"],
    "AdorshoLipi": ["AdorshoLipi_20-07-2007.ttf"],
    "Mukti": ["Mukti_1.99_PR.ttf"],
    "Mukti Narrow": ["muktinarrow.ttf"],
    "Akaash": ["akaashnormal.ttf"],
    "Mitra Mono": ["mitra.ttf"],
    "Sagar": ["sagarnormal.ttf"],
    "BenSen": ["BenSen.ttf"],
    "BenSen Handwriting": ["BenSenHandwriting.ttf"],
    "Lohit Bengali": ["Lohit_14-04-2007.ttf"],
    "Apona Lohit": ["AponaLohit.ttf"],
}
GOOGLE_API = "https://api.github.com/repos/google/fonts"
GOOGLE_RAW = "https://raw.githubusercontent.com/google/fonts/main/"
UA = {"User-Agent": "PDF-Editor-font-fetcher"}


class Offline(Exception):
    pass


class NotFound(Exception):
    pass


def online(timeout=4):
    for host in ("raw.githubusercontent.com", "github.com"):
        try:
            socket.create_connection((host, 443), timeout=timeout).close()
            return True
        except OSError:
            continue
    return False


def _get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(url)
        raise
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        if not online():
            raise Offline()
        raise e


def _google_dirs():
    """{dirname: 'ofl/dirname'} for every Google Fonts family (cached for a week)."""
    cache = os.path.join(CACHE_DIR, "google_fonts.json")
    try:
        with open(cache, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if time.time() - saved["time"] < 7 * 86400:
            return saved["dirs"]
    except Exception:
        pass
    top = json.loads(_get(GOOGLE_API + "/git/trees/main"))
    dirs = {}
    for t in top["tree"]:
        if t["path"] in ("ofl", "apache", "ufl") and t["type"] == "tree":
            sub = json.loads(_get(GOOGLE_API + "/git/trees/" + t["sha"]))
            for s in sub["tree"]:
                if s["type"] == "tree":
                    dirs[s["path"]] = t["path"] + "/" + s["path"]
    try:
        with open(cache, "w", encoding="utf-8") as f:
            json.dump({"time": time.time(), "dirs": dirs}, f)
    except OSError:
        pass
    return dirs


def search(query, limit=60):
    if not online():
        raise Offline()
    q = norm(query)
    names = list(BANGLA)
    try:
        names += sorted(_google_dirs())
    except Offline:
        raise
    except Exception:
        pass
    hits = [n for n in names if q in norm(n)] if q else names
    hits.sort(key=lambda n: (not norm(n).startswith(q), len(n)))
    return hits[:limit]


def _save(name, data):
    safe = re.sub(r"[^A-Za-z0-9._ \-\[\],]", "_", name)
    path = os.path.join(USER_FONT_DIR, safe)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _static_instances(data, filename):
    """Google ships many families as variable fonts; the editor needs plain
    Regular / Bold files, so cut those out."""
    from fontTools.varLib import instancer
    out = []
    base = re.sub(r"\[.*?\]", "", os.path.splitext(filename)[0]).rstrip("-_")
    base = re.sub(r"[-_]?italic$", "", base, flags=re.I)
    italic = "italic" in filename.lower()
    tt = TTFont(io.BytesIO(data))
    axes = {a.axisTag: a for a in tt["fvar"].axes}
    for weight, style in ((400, "Italic" if italic else "Regular"), (700, "BoldItalic" if italic else "Bold")):
        if "wght" in axes and not axes["wght"].minValue <= weight <= axes["wght"].maxValue:
            continue
        loc = {tag: a.defaultValue for tag, a in axes.items()}
        if "wght" in axes:
            loc["wght"] = weight
        if "ital" in axes:
            loc["ital"] = 1 if italic else 0
        f = TTFont(io.BytesIO(data))
        try:
            inst = instancer.instantiateVariableFont(f, loc, updateFontNames=True)
        except Exception:
            f = TTFont(io.BytesIO(data))
            inst = instancer.instantiateVariableFont(f, loc)
            _rename(inst, style)
        bio = io.BytesIO()
        inst.save(bio)
        out.append(("%s-%s.ttf" % (base, style), bio.getvalue()))
    return out


def _rename(tt, style):
    name = tt["name"]
    fam = name.getDebugName(16) or name.getDebugName(1)
    sub = {"Regular": "Regular", "Bold": "Bold", "Italic": "Italic", "BoldItalic": "Bold Italic"}[style]
    for rec in list(name.names):
        if rec.nameID in (16, 17, 25):
            name.removeNames(nameID=rec.nameID)
    name.setName(fam, 1, 3, 1, 0x409)
    name.setName(sub, 2, 3, 1, 0x409)
    name.setName("%s %s" % (fam, sub) if sub != "Regular" else fam, 4, 3, 1, 0x409)
    name.setName(re.sub(r"\s", "", fam) + "-" + style, 6, 3, 1, 0x409)
    os2 = tt["OS/2"]
    os2.usWeightClass = 700 if "Bold" in style else 400
    sel = os2.fsSelection & ~0x61
    if "Bold" in style:
        sel |= 0x20
    if "Italic" in style:
        sel |= 0x01
    if sel & 0x21 == 0:
        sel |= 0x40
    os2.fsSelection = sel


def _resolve(family):
    """Find a downloadable family for a font or PDF font name."""
    base = strip_subset(family)
    cands = []
    for c in (norm(base), norm(re.split(r"[-,]", base)[0]), _strip_style(norm(base))):
        if c and c not in cands:
            cands.append(c)
    for c in cands:
        for name in BANGLA:
            if norm(name) == c:
                return "bangla", name
    dirs = _google_dirs()
    for c in cands:
        if c in dirs:
            return "google", dirs[c]
    return None, None


def fetch(family):
    """Download a family into the user font folder. Returns the saved file paths."""
    if not online():
        raise Offline()
    kind, key = _resolve(family)
    if kind is None:
        raise NotFound(family)
    saved = []
    if kind == "bangla":
        for fn in BANGLA[key]:
            saved.append(_save(fn, _get(BANGLA_BASE + urllib.request.quote(fn))))
        return saved
    listing = json.loads(_get(GOOGLE_API + "/contents/" + key))
    files = [f for f in listing if f["name"].lower().endswith((".ttf", ".otf"))]
    if not files:
        static = next((f for f in listing if f["name"] == "static" and f["type"] == "dir"), None)
        if static:
            files = [f for f in json.loads(_get(static["url"])) if f["name"].lower().endswith(".ttf")]
    for f in files:
        data = _get(f["download_url"])
        if "[" in f["name"]:
            try:
                for name, inst in _static_instances(data, f["name"]):
                    saved.append(_save(name, inst))
                continue
            except Exception:
                pass
        saved.append(_save(f["name"], data))
    if not saved:
        raise NotFound(family)
    return saved
