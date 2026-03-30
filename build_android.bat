@echo off
title Fortress Options - Build Android APK
color 0B

echo ============================================================
echo   FORTRESS OPTIONS - Android APK Builder
echo ============================================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from nodejs.org
    pause & exit /b 1
)

:: Install npm deps
echo [1/4] Installing npm dependencies...
npm install
if errorlevel 1 ( echo FAILED & pause & exit /b 1 )

:: Build React app
echo.
echo [2/4] Building React app...
npm run build
if errorlevel 1 ( echo FAILED & pause & exit /b 1 )

:: Add Android platform if not present
if not exist android (
    echo.
    echo [3/4] Adding Android platform...
    npx cap add android
) else (
    echo.
    echo [3/4] Syncing with Android platform...
    npx cap sync android
)
if errorlevel 1 ( echo FAILED & pause & exit /b 1 )

echo.
echo [4/4] Opening Android Studio...
echo.
echo  In Android Studio:
echo    Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)
echo    The APK will be in: android\app\build\outputs\apk\debug\
echo.
npx cap open android

echo.
echo Done! If Android Studio is not installed, download from:
echo https://developer.android.com/studio
echo.
pause
