@echo off
setlocal EnableDelayedExpansion
title oldCalltrainer - commit and push

set "PROJ=C:\Users\Dell\Downloads\Projekte\callTrainer\oldCalltrainer"
if exist "%~dp0package.json" set "PROJ=%~dp0"
cd /d "%PROJ%"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Git is not installed - https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     oldCalltrainer - push to GitHub
echo     https://github.com/KollegDev/oldCalltrainer
echo   ============================================================
echo.

rem Safety: the .env in this folder holds a REAL Gemini API key.
rem It is gitignored, but if it ever ends up tracked, stop everything.
git ls-files --error-unmatch .env >nul 2>nul
if !errorlevel! equ 0 (
  echo   STOP: .env is tracked by git. It contains a real API key.
  echo   Run:  git rm --cached .env
  echo   then push again. Nothing was pushed.
  echo.
  pause
  exit /b 1
)

rem Uncommitted work. --porcelain also catches new files.
set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain') do set "DIRTY=1"

rem Commits that exist locally but not on the remote.
set "AHEAD="
for /f %%C in ('git rev-list --count "@{u}..HEAD" 2^>nul') do set "AHEAD=%%C"
if not defined AHEAD (
  echo   No upstream branch yet - this will be the first push.
  set "AHEAD=1"
)

if defined DIRTY (
  echo   Uncommitted changes:
  echo.
  git status --short
  echo.
) else (
  echo   Working tree clean.
)
echo   Commits waiting to be pushed: !AHEAD!
echo.

if not defined DIRTY if "!AHEAD!"=="0" (
  echo   Nothing to commit and nothing to push - GitHub is up to date.
  echo.
  pause
  exit /b 0
)

if defined DIRTY (
  set "MSG="
  set /p "MSG=  Commit message (Enter for 'update'): "
  if "!MSG!"=="" set "MSG=update"
  git add -A
  git commit -m "!MSG!"
  if !errorlevel! neq 0 (
    echo.
    echo   Commit failed.
    pause
    exit /b 1
  )
)

echo.
echo   Pushing to origin/main...
git push -u origin main
if !errorlevel! neq 0 (
  echo.
  echo   Push failed.
  echo.
  echo   If it says the remote has work you do not have locally:
  echo       git pull --rebase origin main
  echo   then run push again.
  echo.
  echo   If it asks for credentials repeatedly:
  echo       git config --global credential.helper manager
  echo.
  pause
  exit /b 1
)

echo.
echo   Pushed to https://github.com/KollegDev/oldCalltrainer
echo.
pause
