@echo off
rem ============================================================
rem  Photo Flipbook - find a Python that can import Pillow
rem  NOTE: this file MUST stay CRLF + pure ASCII.
rem        cmd.exe cannot parse LF-only batch files, and the
rem        default codepage (936) corrupts non-ASCII bytes.
rem
rem  Sets PYEXE to a usable interpreter. If none is found, PYEXE
rem  stays undefined and the launcher prints its own error.
rem  Called by the launcher bat - do not run it directly.
rem
rem  Search order mirrors run.py, so the two entry points behave
rem  identically:
rem    1) a portable interpreter shipped next to the tool
rem    2) per-user / machine installs, newest version first
rem    3) py / python / python3 from PATH
rem ============================================================
setlocal enabledelayedexpansion
set "PYEXE="

rem ---- 1) portable interpreters bundled with the tool --------
for %%P in (
    "%~dp0python\python.exe"
    "%~dp0runtime\python\python.exe"
) do (
    if not defined PYEXE if exist "%%~fP" call :try "%%~fP"
)

rem ---- 2) common install locations, newest first -------------
rem  dir /o-n sorts descending, so Python313 comes before Python312
for %%D in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if not defined PYEXE if exist "%%~fD" (
        for /f "delims=" %%V in ('dir /b /o-n "%%~fD\Python3*" 2^>nul') do (
            if not defined PYEXE if exist "%%~fD\%%V\python.exe" call :try "%%~fD\%%V\python.exe"
        )
    )
)

rem ---- 3) whatever PATH offers -------------------------------
if not defined PYEXE call :try "py"
if not defined PYEXE call :try "python"
if not defined PYEXE call :try "python3"

rem  hand the result back to the caller (setlocal would hide it)
endlocal & set "PYEXE=%PYEXE%"
exit /b 0

:try
rem  %1 = interpreter to test. Adopt it only if `import PIL` works.
"%~1" -c "import PIL, sys; sys.exit(0)" >nul 2>nul
if not errorlevel 1 set "PYEXE=%~1"
exit /b 0
