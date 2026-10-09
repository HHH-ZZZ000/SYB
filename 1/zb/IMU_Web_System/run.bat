@echo off
setlocal
cd /d "%~dp0"
title IMU Web System

if exist ".venv\Scripts\python.exe" goto check_dependencies
where py >nul 2>nul
if not errorlevel 1 goto create_with_py
where python >nul 2>nul
if errorlevel 1 goto missing_python
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 goto missing_python
python -m venv .venv
if errorlevel 1 goto failed
goto check_dependencies

:create_with_py
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 goto missing_python
py -3 -m venv .venv
if errorlevel 1 goto failed

:check_dependencies
".venv\Scripts\python.exe" -c "from importlib.metadata import version; import flask, flask_sock, PIL, cv2, numpy; assert version('opencv-contrib-python-headless') == '4.10.0.84'; assert version('numpy') == '2.2.6'; v=tuple(map(int,version('flask').split('.')[:2])); assert (3,1) <= v < (4,0)" >nul 2>nul
if not errorlevel 1 goto start_server
echo Installing Python dependencies. Internet is needed on first setup only...
".venv\Scripts\python.exe" -m pip install -r server\requirements.txt
if errorlevel 1 goto failed

:start_server
echo.
echo IMU Web System: http://127.0.0.1:5000
echo ESP32 must use this computer's LAN IPv4 address in SERVER_URL.
echo Keep this window open. Press Ctrl+C to stop the server.
echo.
".venv\Scripts\python.exe" server\app.py
if errorlevel 1 goto failed
goto end

:missing_python
echo Python 3.10 or newer is required. Install Python and enable Add to PATH.
pause
exit /b 1

:failed
echo.
echo Startup failed. Review the error above and README.md.
echo If port 5000 is already in use, stop the other server before retrying.
pause
exit /b 1

:end
endlocal
