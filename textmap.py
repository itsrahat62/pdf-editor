"""Reading and rewriting /ActualText marked content.

Report generators such as JasperReports draw shaped Bangla glyphs and keep the
real Unicode text in an /ActualText entry around them (one entry per text
field, lines separated by newlines). The glyphs alone do not give readable
text, and MuPDF spreads the ActualText over the glyphs only approximately, so
the editor takes the line geometry from the glyphs and the words from here.
"""
import re

_WS = b" \t\r\n\f\x00"
_ESC = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f",
        b"(": b"(", b")": b")", b"\\": b"\\"}


def _literal(data, i):
    """Parse a PDF literal string starting at data[i] == '('. Returns (bytes, end)."""
    out = bytearray()
    depth = 0
    n = len(data)
    while i < n:
        c = data[i:i + 1]
        if c == b"\\":
            nxt = data[i + 1:i + 2]
            if nxt in _ESC:
                out += _ESC[nxt]
                i += 2
            elif nxt.isdigit():
                m = re.match(rb"[0-7]{1,3}", data[i + 1:i + 4])
                out.append(int(m.group(0), 8) & 255)
                i += 1 + len(m.group(0))
            elif nxt in (b"\r", b"\n"):
                i += 2
                if nxt == b"\r" and data[i:i + 1] == b"\n":
                    i += 1
            else:
                out += nxt
                i += 2
            continue
        if c == b"(":
            depth += 1
            if depth > 1:
                out += c
        elif c == b")":
            depth -= 1
            if depth == 0:
                return bytes(out), i + 1
            out += c
        else:
            out += c
        i += 1
    return bytes(out), n


def _hexstring(data, i):
    j = data.find(b">", i)
    if j < 0:
        j = len(data)
    h = re.sub(rb"[^0-9A-Fa-f]", b"", data[i + 1:j])
    if len(h) % 2:
        h += b"0"
    return bytes.fromhex(h.decode()), j + 1


def decode_text(raw):
    if raw[:2] == b"\xfe\xff":
        return raw[2:].decode("utf-16-be", "replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", "replace")
    return raw.decode("latin-1")


def encode_text(text):
    return b"<FEFF" + text.encode("utf-16-be").hex().upper().encode() + b">"


def find_actualtext(data):
    """Yield (start, end, text) for every /ActualText string value in a content stream."""
    pos = 0
    while True:
        k = data.find(b"/ActualText", pos)
        if k < 0:
            return
        i = k + len(b"/ActualText")
        while i < len(data) and data[i:i + 1] in _WS:
            i += 1
        c = data[i:i + 1]
        if c == b"(":
            raw, end = _literal(data, i)
        elif c == b"<" and data[i:i + 2] != b"<<":
            raw, end = _hexstring(data, i)
        else:
            pos = i
            continue
        yield i, end, decode_text(raw)
        pos = end


def page_fields(page):
    """All ActualText texts of the page, in content order: [(xref, start, end, text)]."""
    doc = page.parent
    out = []
    for xref in page.get_contents():
        try:
            data = doc.xref_stream(xref) or b""
        except Exception:
            continue
        for s, e, t in find_actualtext(data):
            out.append((xref, s, e, t))
    return out


def set_field(page, index, text):
    """Replace the text of the index-th ActualText entry on the page."""
    fields = page_fields(page)
    if not 0 <= index < len(fields):
        return False
    xref, s, e, _ = fields[index]
    doc = page.parent
    data = doc.xref_stream(xref)
    doc.update_stream(xref, data[:s] + encode_text(text) + data[e:])
    return True


def wrap_new_contents(page, before, text):
    """Wrap content streams added since `before` (a list of xrefs) in an ActualText span,
    so the inserted glyphs extract as `text`."""
    doc = page.parent
    added = [x for x in page.get_contents() if x not in before]
    if len(added) > 1:
        # PyMuPDF may also add "q" / "Q" streams around the old content
        added = [x for x in added if b"Do" in (doc.xref_stream(x) or b"")]
    if len(added) != 1:
        return False
    xref = added[0]
    data = doc.xref_stream(xref) or b""
    doc.update_stream(xref, b"/Span <</ActualText " + encode_text(text) + b">> BDC\n" + data + b"\nEMC\n")
    return True
