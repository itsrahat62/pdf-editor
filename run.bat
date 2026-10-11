@echo off
rem Runs PDF Editor from source (creates the Python environment on first use).
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
    python -m venv .venv || exit /b 1
    .venv\Scripts\python.exe -m pip install --quiet -r requirements.txt || exit /b 1
)
start "" .venv\Scripts\pythonw.exe app.py %*
