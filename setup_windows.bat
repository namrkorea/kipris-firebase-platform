@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo [1/4] Node.js //
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js/////. Node.js 20.9 ////.
  pause
  exit /b 1
)

echo.
echo [2/4] Web ////
cd /d "%~dp0web"
call npm install
if errorlevel 1 (
  echo Web ////////////.
  pause
  exit /b 1
)

if not exist ".env.local" copy ".env.local.example" ".env.local" >nul

echo.
echo [3/4] Python /////////////
cd /d "%~dp0worker"
where py >nul 2>nul
if errorlevel 1 (
  echo Python//////////////. Python 3.11 // 3.12///////.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv 2>nul
  if errorlevel 1 py -3.11 -m venv .venv
)

if not exist ".venv\Scripts\python.exe" (
  echo Python ////////////.
  pause
  exit /b 1
)

call ".venv\Scripts\python.exe" -m pip install --upgrade pip
call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Worker //////////////.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul

echo.
echo [4/4] ////////////
echo web\.env.local // worker\.env ////////////.
echo //// Supabase SQL Editor// supabase\001_schema.sql /////.
pause
