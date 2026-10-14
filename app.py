"""PDF Editor - desktop app entry point.

Runs a small local web server (only reachable from this PC) and shows the UI
in a native window. Use --browser to open it in the default browser instead.
"""
import argparse
import io
import os
import socket
import sys
import threading
import webbrowser

from flask import Flask, Response, jsonify, request, send_file, send_from_directory
from werkzeug.serving import make_server

import font_online
from font_manager import FontManager
from paths import STATIC_DIR
from pdf_engine import EditError, PdfEditor

APP_NAME = "PDF Editor"

fonts = FontManager()
editor = PdfEditor(fonts)
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024


@app.errorhandler(EditError)
def _edit_error(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(Exception)
def _any_error(e):
    code = getattr(e, "code", 500)
    return jsonify({"error": str(e) or e.__class__.__name__}), code if isinstance(code, int) else 500


@app.after_request
def _no_cache(resp):
    if request.path.startswith("/api/") and "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


@app.get("/api/state")
def api_state():
    return jsonify(editor.state())


def _done(result=None):
    return jsonify({"result": result, "state": editor.state()})


def _json():
    return request.get_json(force=True) or {}


IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp")


@app.post("/api/open")
def api_open():
    files = request.files.getlist("file")
    if not files:
        raise EditError("No file was sent.")
    if all((f.filename or "").lower().endswith(IMAGE_EXTS) for f in files):
        base = os.path.splitext(os.path.basename(files[0].filename))[0]
        editor.open_images([(f.filename, f.read()) for f in files], base + ".pdf")
    else:
        f = files[0]
        editor.open(f.read(), os.path.basename(f.filename or "document.pdf"), request.form.get("password") or None)
    return jsonify(editor.state())


@app.get("/api/page/<int:pno>.png")
def api_page(pno):
    data = editor.render(pno, request.args.get("scale", 1.5, type=float))
    resp = Response(data, mimetype="image/png")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@app.get("/api/page/<int:pno>/lines")
def api_lines(pno):
    out = editor.lines(pno)
    out.update(editor.objects(pno))
    return jsonify(out)


@app.post("/api/page/<int:pno>/edit")
def api_edit(pno):
    d = _json()
    return _done(editor.edit_line(pno, d["line"], d.get("segs", []), d.get("ov"), d.get("move")))


@app.post("/api/page/<int:pno>/add_text")
def api_add_text(pno):
    d = _json()
    return _done(editor.add_text(pno, d["x"], d["y"], d.get("text", ""), d.get("family"), bool(d.get("bold")),
                                 bool(d.get("italic")), d.get("size", 12), d.get("color", 0)))


@app.post("/api/page/<int:pno>/textbox")
def api_textbox(pno):
    d = _json()
    return _done(editor.add_textbox(pno, d["rect"], d.get("text", ""), d.get("family"), bool(d.get("bold")),
                                    bool(d.get("italic")), d.get("size", 12), d.get("color", 0),
                                    d.get("align", "left"), d.get("border"), d.get("fill")))


@app.post("/api/page/<int:pno>/erase")
def api_erase(pno):
    d = _json()
    return _done(editor.erase(pno, d["rect"], d.get("color", 0xFFFFFF)))


@app.post("/api/page/<int:pno>/image")
def api_image(pno):
    f = request.files.get("file")
    if not f:
        raise EditError("No image was sent.")
    rect = [float(v) for v in request.form["rect"].split(",")]
    return _done(editor.insert_image(pno, rect, f.read()))


@app.post("/api/page/<int:pno>/annot")
def api_annot(pno):
    return _done(editor.add_annot(pno, _json()))


@app.post("/api/page/<int:pno>/annot/delete")
def api_annot_delete(pno):
    return _done(editor.delete_annot(pno, _json()["xref"]))


@app.post("/api/page/<int:pno>/widget")
def api_widget(pno):
    d = _json()
    return _done(editor.set_widget(pno, d["xref"], d.get("value")))


@app.post("/api/find")
def api_find():
    d = _json()
    return jsonify({"results": editor.find(d.get("query", ""), bool(d.get("case")))})


@app.post("/api/replace")
def api_replace():
    d = _json()
    return _done(editor.replace_all(d.get("query", ""), d.get("repl", ""), bool(d.get("case"))))


@app.post("/api/pages/<action>")
def api_pages(action):
    if action in ("insert_pdf", "insert_images"):
        at = int(request.form.get("at", editor.doc.page_count if editor.doc else 0))
        files = request.files.getlist("file")
        if not files:
            raise EditError("No file was sent.")
        if action == "insert_pdf":
            return _done(editor.insert_pdf(at, files[0].read(), request.form.get("password")))
        return _done(editor.insert_images(at, [(f.filename, f.read()) for f in files]))
    d = _json()
    if action == "insert_blank":
        return _done(editor.insert_blank(int(d.get("at", 0))))
    if action == "move":
        return _done(editor.move_page(int(d["src"]), int(d["dst"])))
    if action == "duplicate":
        return _done(editor.duplicate_page(int(d["page"])))
    if action == "delete":
        return _done(editor.delete_pages([int(p) for p in d["pages"]]))
    if action == "rotate":
        return _done(editor.rotate_pages([int(p) for p in d["pages"]], int(d.get("deg", 90))))
    raise EditError("Unknown page action.")


@app.post("/api/watermark")
def api_watermark():
    d = _json()
    return _done(editor.watermark(d.get("text", ""), float(d.get("size", 60)), int(d.get("color", 0x888888)),
                                  float(d.get("opacity", 0.25)), float(d.get("angle", 45)), d.get("family") or None,
                                  bool(d.get("bold", True)), d.get("pages", "all")))


@app.post("/api/header_footer")
def api_header_footer():
    d = _json()
    return _done(editor.header_footer(d.get("text", ""), d.get("position", "bottom-center"),
                                      float(d.get("size", 10)), int(d.get("color", 0)), d.get("family") or None,
                                      float(d.get("margin", 28)), int(d.get("start", 1)), d.get("pages", "all")))


@app.route("/api/metadata", methods=["GET", "POST"])
def api_metadata():
    if request.method == "POST":
        return _done(editor.set_metadata(_json()))
    return jsonify(editor.metadata())


@app.post("/api/flatten")
def api_flatten():
    return _done(editor.flatten_forms())


@app.post("/api/undo")
def api_undo():
    editor.undo()
    return _done()


@app.post("/api/redo")
def api_redo():
    editor.redo()
    return _done()


@app.get("/api/fonts")
def api_fonts():
    return jsonify({"families": fonts.families()})


@app.post("/api/fonts/add")
def api_fonts_add():
    added = []
    for f in request.files.getlist("file"):
        try:
            added.append(fonts.add_font(f.filename, f.read()))
        except Exception as e:
            raise EditError("%s: %s" % (f.filename, e))
    editor.forget_fonts()
    return jsonify({"added": added, "families": fonts.families()})


@app.get("/api/fonts/online")
def api_fonts_online():
    try:
        return jsonify({"results": font_online.search(request.args.get("q", ""))})
    except font_online.Offline:
        raise EditError("NO_INTERNET")


@app.post("/api/fonts/online/get")
def api_fonts_online_get():
    family = _json().get("family", "")
    try:
        saved = font_online.fetch(family)
    except font_online.Offline:
        raise EditError("NO_INTERNET")
    except font_online.NotFound:
        raise EditError("NOT_FOUND")
    fonts.rebuild()
    editor.forget_fonts()
    names = set()
    for p in saved:
        for e in fonts._scan_file(p):
            names.add(e["family"])
    return jsonify({"added": sorted(names), "families": fonts.families()})


@app.get("/api/fontface")
def api_fontface():
    """Font file used to preview text in the editor box while typing."""
    a = request.args
    ov = {}
    if a.get("family"):
        ov["family"] = a.get("family")
    if a.get("bold") in ("0", "1"):
        ov["bold"] = a.get("bold") == "1"
    if a.get("italic") in ("0", "1"):
        ov["italic"] = a.get("italic") == "1"
    data = None
    if editor.doc is not None:
        data = editor.font_face_bytes(a.get("page", 0, type=int), a.get("font") or None,
                                      a.get("flags", 0, type=int), ov)
    elif ov.get("family"):
        e = fonts.find_family(ov["family"], ov.get("bold", False), ov.get("italic", False))
        data = fonts.entry_bytes(e) if e else None
    if not data:
        return Response(status=404)
    resp = Response(data, mimetype="font/ttf")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


def _base():
    return os.path.splitext(editor.name or "document")[0]


def _download(data, name, mimetype):
    return send_file(io.BytesIO(data), mimetype=mimetype, as_attachment=True, download_name=name)


@app.get("/api/download")
def api_download():
    return _download(editor.export_protected(request.args.get("password") or None),
                     _base() + "-edited.pdf", "application/pdf")


@app.get("/api/extract")
def api_extract():
    pages = [int(p) for p in request.args.get("pages", "").split(",") if p.strip()]
    if not pages:
        raise EditError("Select the pages to extract.")
    return _download(editor.extract_pages(pages), _base() + "-pages.pdf", "application/pdf")


@app.get("/api/export_images")
def api_export_images():
    a = request.args
    return _download(editor.export_images(a.get("dpi", 150, type=int), a.get("pages", "all"), a.get("fmt", "png")),
                     _base() + "-images.zip", "application/zip")


class JsApi:
    """Functions callable from the UI when running inside the native window."""

    def __init__(self):
        self._window = None  # underscore: keeps pywebview from exposing it to JS

    def save_url(self, path):
        """Fetch one of the download endpoints and save it where the user chooses."""
        import webview
        with app.test_client() as c:
            resp = c.get(path)
        if resp.status_code != 200:
            try:
                return {"saved": False, "error": resp.get_json().get("error")}
            except Exception:
                return {"saved": False, "error": "Could not create the file."}
        cd = resp.headers.get("Content-Disposition", "")
        name = cd.split("filename=")[-1].strip('"') if "filename=" in cd else "download"
        ext = os.path.splitext(name)[1].lower()
        types = {".pdf": ("PDF file (*.pdf)",), ".zip": ("ZIP archive (*.zip)",)}.get(ext, ("All files (*.*)",))
        try:
            dialog = webview.FileDialog.SAVE
        except AttributeError:
            dialog = webview.SAVE_DIALOG
        target = self._window.create_file_dialog(dialog, save_filename=name, file_types=types)
        if not target:
            return {"saved": False}
        if isinstance(target, (list, tuple)):
            target = target[0]
        if ext and not target.lower().endswith(ext):
            target += ext
        try:
            with open(target, "wb") as f:
                f.write(resp.data)
        except Exception as e:
            return {"saved": False, "error": str(e)}
        return {"saved": True, "path": target}


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--no-open", action="store_true", help="with --browser: do not launch the browser")
    ap.add_argument("file", nargs="?", help="PDF to open at start")
    args = ap.parse_args()

    if os.environ.get("PDFEDITOR_DEBUG"):
        # dumps every thread's stack to %LOCALAPPDATA%\PdfEditor\debug.txt after 20 s
        import faulthandler
        from paths import DATA_DIR
        faulthandler.dump_traceback_later(20, file=open(os.path.join(DATA_DIR, "debug.txt"), "w"))

    if args.file and os.path.isfile(args.file):
        try:
            with open(args.file, "rb") as f:
                editor.open(f.read(), os.path.basename(args.file))
        except Exception:
            pass

    port = args.port or _free_port()
    server = make_server("127.0.0.1", port, app, threaded=True)
    url = "http://127.0.0.1:%d/" % port

    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()

    if not args.browser:
        try:
            import webview
            api = JsApi()
            api._window = webview.create_window(APP_NAME, url, js_api=api, width=1360, height=880,
                                               min_size=(900, 600))
            webview.start()
            return
        except Exception as e:  # no WebView2 runtime etc. -> fall back to the browser
            if sys.stderr:
                sys.stderr.write("Native window unavailable (%s); using the browser.\n" % e)
    if not args.no_open:
        webbrowser.open(url)
    if sys.stdout:
        print("%s running at %s  (close this window to quit)" % (APP_NAME, url))
    try:
        while serving.is_alive():
            serving.join(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
