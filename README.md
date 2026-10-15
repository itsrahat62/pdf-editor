# PDF Editor

A Windows desktop app for editing PDF files — change existing text **in the document's own font**, type Bangla with **Avro** or **Bijoy**, add images, signatures and comments, organise pages, and download the result.

Everything runs on your own PC; no file is uploaded anywhere.

## Download

Get `PDF-Editor-Setup.exe` from the [Releases](../../releases) page and run it. It installs for the current user (no administrator rights needed) on Windows 10 and 11, 64-bit.

## Features

**Edit**
- **Edit text** — click a line and retype it. Font, size, colour and position are kept; a line that mixes styles (a bold word in a normal sentence) keeps them.
- **Same-font matching** — the original font is taken from the PDF itself, or from the same font installed on the PC (e.g. `NikoshBAN`, `Calibri-Bold`). If it is missing, a similar font is used and the app says so, with a **Get it online** button.
- Works with report-generated Bangla PDFs (JasperReports / OpenPDF government forms) whose text is stored as *ActualText*.
- **Add text**, **Text box** (paragraph that wraps), **Move** a line, **Image**, **Signature** (draw or type, saved for next time), **Erase** (really removes what is under the box).
- **Find & Replace** across all pages, Bangla included.
- **Edit several lines at once** — in *Edit text*, drag over lines with the mouse (like selecting text) or Ctrl/Shift-click lines. The selected lines open together in **one box**, each at its place and in its own font; move around and type anywhere in it, then press `Enter` to apply all. Lines in between that were not selected stay visible in grey (Ctrl+click one to add it). `Ctrl+A` takes every line of the page.
- Clicking or selecting never changes the page by itself: lines that were not typed in stay exactly as they were.
- Change font, size, colour, bold/italic.

**Bangla typing**
- Built-in **Avro Phonetic** (`ami banglay gan gai` → আমি বাংলায় গান গাই) and **Bijoy** keyboard — no other software needed. `F12` switches between English and Bangla.
- Old **Bijoy / SutonnyMJ (ANSI)** PDFs: their text is shown as normal Bangla while you edit, and saved back in the same SutonnyMJ font.

**Fonts**
- Every font installed on the PC, plus bundled open fonts.
- **Fonts → download** free fonts from the internet: the Bangla fonts Nikosh, NikoshBAN, SolaimanLipi, Kalpurush, Siyam Rupali, … and the whole Google Fonts library. Without internet the app tells you there is no connection.
- When a PDF uses a font this PC does not have, a message at the top offers to **Download** it, shows the progress in per cent and then *Complete*; the font is used right away.
- **+ Font** adds a `.ttf` / `.otf` file from the PC.

**Comment**
- Highlight, underline, strike-out, sticky notes, freehand drawing, rectangle, ellipse, line, arrow; select a comment and press `Delete` to remove it.

**Pages**
- Insert blank pages, insert another PDF (merge), insert images, duplicate, rotate, delete, extract pages to a new PDF, drag thumbnails to reorder. `Ctrl`/`Shift` select several pages.

**Tools**
- Watermark, header & footer, page numbers (Bangla text works too).
- Fill PDF forms, flatten forms.
- Password-protect the downloaded PDF (AES-256).
- Export pages as PNG/JPG images; create a PDF from images.
- Document properties; print; undo / redo.
- Warns before closing the app or opening another PDF when changes have not been downloaded yet.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+P` | Open / Download / Print |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+F` | Find & Replace |
| `F12` | English ↔ Bangla keyboard |
| `Enter` / `Esc` | Apply / cancel a text edit |
| `Ctrl +` / `Ctrl -` | Zoom |

## Limits worth knowing

- Text is edited one line at a time; paragraphs do not re-flow automatically.
- Scanned PDFs are pictures — use *Erase* and *Add text* / *Text box* on them (there is no OCR).
- Paid fonts (for example SutonnyMJ) cannot be downloaded; install them on the PC.

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

Creates the portable app in `dist\PDF Editor\` and, when [Inno Setup 6](https://jrsoftware.org/isinfo.php) is installed, `release\PDF-Editor-Setup.exe`.

## Project layout

| File | Purpose |
| --- | --- |
| `app.py` | Entry point: local web server + native window, HTTP API |
| `pdf_engine.py` | Text extraction and line editing (PyMuPDF) |
| `textmap.py` | Reads / rewrites `/ActualText` so shaped Bangla stays editable |
| `pdf_features.py` | Images, comments, text boxes, find & replace, pages, watermark, forms, export |
| `font_manager.py` | Indexes installed fonts and matches PDF font names to font files |
| `font_online.py` | Downloads missing fonts |
| `static/` | User interface; `bangla.js` (Avro / Bijoy keyboards), `ansi.js` (SutonnyMJ ↔ Unicode) |
| `fonts/` | Bundled open-source fonts |

## Licences

The application code is released under the MIT licence (see `LICENSE`).

Third-party parts:
- [PyMuPDF](https://pymupdf.readthedocs.io/) — AGPL-3.0 (this repository is the corresponding source).
- [Flask](https://flask.palletsprojects.com/), [pywebview](https://pywebview.flowrl.com/), [fontTools](https://github.com/fonttools/fonttools).
- `static/vendor/avro-lib.js` — jsAvroPhonetic by OmicronLab / Rifat Nabi, Mozilla Public License 1.1 (`licenses/MPL-1.1-avro-phonetic.txt`).
- `static/vendor/bijoy2unicode.js` — bijoy2unicode by Md. Jehad, MIT.
- Fonts in `fonts/` (Hind Siliguri, Tiro Bangla, Galada, Poppins, Lato, PT Serif) — SIL Open Font License 1.1.
- Downloaded Bangla fonts come from [hmoazzem/bangla-fonts](https://github.com/hmoazzem/bangla-fonts); Google Fonts from [google/fonts](https://github.com/google/fonts).
