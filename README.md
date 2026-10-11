# PDF Editor

A Windows desktop app for editing the text of existing PDF files **in the same font** the document already uses.

Open a PDF, click any line of text, type your change, and download the edited PDF. Everything runs on your own PC — no file is uploaded anywhere.

## Features

- **Edit existing text** — click a line and retype it. Size, colour, bold/italic and position are preserved, and mixed styles on one line (for example a bold word in a normal sentence) stay intact.
- **Same-font matching** — for each piece of text the editor looks for the original font in this order:
  1. the font embedded in the PDF itself (when it contains the characters you typed),
  2. the same font installed on the PC (matched by its real name, e.g. `Calibri-Bold`),
  3. the standard PDF fonts (Helvetica, Times, Courier),
  4. a close look-alike, with a warning so you know it is not exact.
- **Add new text** anywhere, with any installed font, size and colour.
- **Erase** an area (removes what is under it instead of just covering it).
- **Change font, size, colour, bold/italic** of a line.
- **Add your own fonts** (`.ttf` / `.otf`) with the *+ Font* button.
- **Bangla and other complex scripts** are shaped correctly when typed.
- Rotate / delete pages, undo / redo, zoom, drag & drop, password-protected PDFs.

## Install

Download `PDF-Editor-Setup.exe` from the [Releases](../../releases) page and run it. It installs for the current user, so administrator rights are not needed. Works on Windows 10 and 11 (64-bit).

The app window uses the Microsoft Edge WebView2 runtime, which is already part of Windows 10/11. If it is missing, the editor opens in your default browser instead.

## How to use

| Action | How |
| --- | --- |
| Open a PDF | **Open** button, `Ctrl+O`, or drag the file into the window |
| Edit text | **Edit text** tool → click a line → type → `Enter` (`Esc` cancels) |
| Add text | **Add text** tool → click the spot → type → `Enter` (`Shift+Enter` = new line) |
| Erase | **Erase** tool → drag a box over the area |
| Save | **Download** button or `Ctrl+S` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |

While you edit a line, the bar under the toolbar shows which font is being used and whether it is an exact match.

## Limits worth knowing

- Text is edited one line at a time; paragraphs do not re-wrap automatically.
- Scanned PDFs are pictures, not text. Use *Erase* and *Add text* on those pages.
- If a PDF uses a font that is not embedded in a usable form and not installed on the PC, a similar font is used and the app tells you. Install the real font (or add it with *+ Font*) to get an exact match.
- PDFs made with old non-Unicode Bangla fonts (Bijoy / SutonnyMJ style) store text as Latin letters, so the line shows that way when you click it. Retype such lines with a Unicode Bangla font.

## Run from source

Requires Python 3.10+ on Windows.

```bat
run.bat
```

or manually:

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py            &rem native window
.venv\Scripts\python app.py --browser  &rem use the default browser
```

## Build the installer

```bat
build.bat
```

This creates the portable app in `dist\PDF Editor\` and, when [Inno Setup 6](https://jrsoftware.org/isinfo.php) is installed, the installer `release\PDF-Editor-Setup.exe`.

## Project layout

| File | Purpose |
| --- | --- |
| `app.py` | Entry point: local web server + native window |
| `pdf_engine.py` | PDF editing (PyMuPDF): extract lines, replace text, add text, erase, undo |
| `font_manager.py` | Indexes installed fonts and matches PDF font names to font files |
| `static/` | The user interface (HTML / CSS / JavaScript) |
| `fonts/` | Bundled open-source fonts |
| `tools/`, `PDFEditor.spec`, `installer.iss`, `build.bat` | Packaging |

## Licences

The application code is released under the MIT licence (see `LICENSE`).

It is built on [PyMuPDF](https://pymupdf.readthedocs.io/) (AGPL-3.0), [Flask](https://flask.palletsprojects.com/), [pywebview](https://pywebview.flowrl.com/) and [fontTools](https://github.com/fonttools/fonttools). Because PyMuPDF is AGPL-licensed, distributing a modified build means making its source available, as this repository does.

The fonts in `fonts/` (Hind Siliguri, Tiro Bangla, Galada, Poppins, Lato, PT Serif) come from Google Fonts and are licensed under the SIL Open Font License 1.1.
