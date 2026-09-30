@echo off
rem ============================================================
rem  Photo Flipbook Studio - the one and only launcher
rem  NOTE: this file MUST stay CRLF + pure ASCII.
rem        cmd.exe cannot parse LF-only batch files, and the
rem        default codepage (936) corrupts non-ASCII bytes.
rem
rem  Double-click this file to open the workbench.
rem  To stop the background service: click "close tool" in the
rem  top-right corner of the page (or just close the window).
rem ============================================================
setlocal
chcp 65001 >nul 2>nul
title Photo Flipbook Studio
cd /d "%~dp0"

rem ---- pick an interpreter that can import PIL -----------------
call "%~dp0_find_python.bat"
if not defined PYEXE (
    echo [ERROR] No Python interpreter found on this machine.
    echo         Install Python and tick "Add Python to PATH",
    echo         then run this file again.
    echo.
    pause
    exit /b 1
)

rem ---- launch detached: no console window is left behind ------
set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul

rem pythonw.exe exists next to python.exe -> fully silent.
rem otherwise fall back to python.exe started via a hidden window.
set "PYW=%PYEXE%"
call set "PYW=%%PYW:python.exe=pythonw.exe%%"
if not exist "%PYW%" set "PYW=%PYEXE%"

rem serve_ui.py itself takes care of the "already running" case:
rem if a workbench is up it just reopens the existing page instead
rem of starting a second server.
start "" /b "%PYW%" "%~dp0app\serve_ui.py" %*
exit /b 0
