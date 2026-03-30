@echo off
title Fortress Options Backend
color 0A

echo ============================================================
echo   FORTRESS OPTIONS - Backend Server
echo ============================================================
echo.
echo  This starts the FastAPI server that powers the Android app.
echo  The app connects to this server over your local Wi-Fi.
echo.
echo  Your local IP (use this in the Android app Settings):
ipconfig | findstr "IPv4"
echo.
echo  Server will be available at: http://[YOUR-IP]:8000
echo  API docs:                    http://localhost:8000/docs
echo.
echo  Press Ctrl+C to stop.
echo ============================================================
echo.

:: Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ from python.org
    pause
    exit /b 1
)

:: Install requirements if needed
echo Checking dependencies...
pip install -r requirements.txt -q --no-warn-script-location
echo.

:: Start the server
echo Starting server...
python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000 --reload

pause
