@echo off
rem Start the Guardian token shim in a visible console window.
rem Requires Python 3 on PATH.

cd /d "%~dp0.."
python "scripts\guardian-shim.py" --port 8787

echo.
echo The shim has stopped. Press any key to close.
pause >nul
