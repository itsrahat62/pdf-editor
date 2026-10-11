@echo off
rem Builds dist\PDF Editor\ (portable app) and release\PDF-Editor-Setup.exe (installer).
setlocal
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
    python -m venv .venv || goto :fail
)
.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt pyinstaller pillow || goto :fail
.venv\Scripts\python.exe tools\make_icon.py || goto :fail
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean PDFEditor.spec || goto :fail

set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" (
    "%ISCC%" /Q installer.iss || goto :fail
    echo Installer: release\PDF-Editor-Setup.exe
) else (
    echo Inno Setup 6 not found - skipped the installer. Portable app is in "dist\PDF Editor".
)
exit /b 0

:fail
echo Build failed.
exit /b 1
