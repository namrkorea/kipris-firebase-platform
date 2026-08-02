@echo off
chcp 65001 > nul
cd /d "%~dp0worker"
if not exist ".venv\Scripts\python.exe" (
  echo //// setup_windows.bat/////.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" worker.py
pause
