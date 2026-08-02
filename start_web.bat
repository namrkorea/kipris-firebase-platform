@echo off
chcp 65001 > nul
cd /d "%~dp0web"
if not exist "node_modules" (
  echo ///setup_windows.bat///.
  pause
  exit /b 1
)
call npm run dev
