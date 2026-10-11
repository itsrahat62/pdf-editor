# PyInstaller spec:  pyinstaller --noconfirm PDFEditor.spec
import os

datas = [("static", "static")]
if os.path.isdir("fonts"):
    datas.append(("fonts", "fonts"))

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    excludes=["tkinter", "PIL", "numpy", "matplotlib", "PyQt5", "PyQt6", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PDF Editor",
    console=False,
    icon="build/icon.ico" if os.path.exists("build/icon.ico") else None,
    version="tools/version_info.txt",
)
coll = COLLECT(exe, a.binaries, a.datas, name="PDF Editor")
