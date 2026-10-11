"""Filesystem locations used by the app (works both from source and as a frozen exe)."""
import os
import sys

FROZEN = getattr(sys, "frozen", False)

# Read-only resources bundled with the app (static web UI, bundled fonts).
RES_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

# Per-user writable data (font index cache, fonts the user adds).
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "PdfEditor")
USER_FONT_DIR = os.path.join(DATA_DIR, "fonts")
CACHE_DIR = os.path.join(DATA_DIR, "cache")

STATIC_DIR = os.path.join(RES_DIR, "static")
BUNDLED_FONT_DIR = os.path.join(RES_DIR, "fonts")

for _d in (DATA_DIR, USER_FONT_DIR, CACHE_DIR):
    os.makedirs(_d, exist_ok=True)


def system_font_dirs():
    dirs = []
    windir = os.environ.get("WINDIR") or r"C:\Windows"
    dirs.append(os.path.join(windir, "Fonts"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
    dirs.append(BUNDLED_FONT_DIR)
    dirs.append(USER_FONT_DIR)
    return [d for d in dirs if os.path.isdir(d)]
