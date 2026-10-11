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


@app.post("/api/open")
def api_open():
    f = request.files.get("file")
    if not f:
        raise EditError("No file was sent.")
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
    return jsonify(editor.lines(pno))


@app.post("/api/page/<int:pno>/edit")
def api_edit(pno):
    d = request.get_json(force=True)
    res = editor.edit_line(pno, d["line"], d.get("segs", []), d.get("ov"))
    return jsonify({"result": res, "state": editor.state()})


@app.post("/api/page/<int:pno>/add_text")
def api_add_text(pno):
    d = request.get_json(force=True)
    res = editor.add_text(pno, d["x"], d["y"], d.get("text", ""), d.get("family"), bool(d.get("bold")),
                          bool(d.get("italic")), d.get("size", 12), d.get("color", 0))
    return jsonify({"result": res, "state": editor.state()})


@app.post("/api/page/<int:pno>/erase")
def api_erase(pno):
    d = request.get_json(force=True)
    res = editor.erase(pno, d["rect"], d.get("color", 0xFFFFFF))
    return jsonify({"result": res, "state": editor.state()})


@app.post("/api/page/<int:pno>/delete")
def api_delete_page(pno):
    editor.delete_page(pno)
    return jsonify({"state": editor.state()})


@app.post("/api/page/<int:pno>/rotate")
def api_rotate_page(pno):
    editor.rotate_page(pno)
    return jsonify({"state": editor.state()})


@app.post("/api/undo")
def api_undo():
    editor.undo()
    return jsonify({"state": editor.state()})


@app.post("/api/redo")
def api_redo():
    editor.redo()
    return jsonify({"state": editor.state()})


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
    return jsonify({"added": added, "families": fonts.families()})


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
    if not data:
        return Response(status=404)
    resp = Response(data, mimetype="font/ttf")
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


def _save_name():
    base = os.path.splitext(editor.name or "document")[0]
    return base + "-edited.pdf"


@app.get("/api/download")
def api_download():
    return send_file(io.BytesIO(editor.export()), mimetype="application/pdf",
                     as_attachment=True, download_name=_save_name())


class JsApi:
    """Functions callable from the UI when running inside the native window."""

    def __init__(self):
        self._window = None  # underscore: keeps pywebview from exposing it to JS

    def save(self):
        import webview
        try:
            dialog = webview.FileDialog.SAVE
        except AttributeError:
            dialog = webview.SAVE_DIALOG
        path = self._window.create_file_dialog(dialog, save_filename=_save_name(),
                                              file_types=("PDF file (*.pdf)",))
        if not path:
            return {"saved": False}
        if isinstance(path, (list, tuple)):
            path = path[0]
        if not path.lower().endswith(".pdf"):
            path += ".pdf"
        try:
            with open(path, "wb") as f:
                f.write(editor.export())
        except Exception as e:
            return {"saved": False, "error": str(e)}
        return {"saved": True, "path": path}


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
