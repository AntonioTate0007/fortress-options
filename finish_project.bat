@echo off
title Fortress Options — Full Project Finalizer
color 0A

echo ============================================================
echo   🏰 FORTRESS OPTIONS — FINAL PROJECT BUILDER
echo ============================================================
echo.

:: 1. Backend Dependencies
echo [1/5] Checking Python requirements...
python -m pip install -r requirements.txt --quiet
if errorlevel 1 ( echo   FAILED to install python deps & pause & exit /b 1 )
echo   DONE.

:: 2. Frontend Dependencies
echo.
echo [2/5] Cleaning and installing npm dependencies...
if exist dist rmdir /s /q dist
npm install --quiet
if errorlevel 1 ( echo   FAILED to install npm deps & pause & exit /b 1 )
echo   DONE.

:: 3. Build Web App
echo.
echo [3/5] Building React production bundle...
npm run build
if errorlevel 1 ( echo   FAILED to build web app & pause & exit /b 1 )
echo   DONE.

:: 4. Sync Android
echo.
echo [4/5] Syncing with Android platform...
if not exist android (
    npx cap add android
) else (
    npx cap sync android
)
if errorlevel 1 ( echo   FAILED to sync capacitor & pause & exit /b 1 )
echo   DONE.

:: 5. Assemble APK (Native)
echo.
echo [5/5] Assembling Android APK (Release)...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 (
    echo.
    echo [!] Native build failed. Falling back: Opening Android Studio...
    cd ..
    npx cap open android
    pause
    exit /b 0
)

:: Copy APK to root
if exist app\build\outputs\apk\debug\app-debug.apk (
    copy app\build\outputs\apk\debug\app-debug.apk ..\fortress-options-v1.2.0.apk /y >nul
    echo.
    echo   SUCCESS! 🏰
    echo   Final APK created: fortress-options-v1.2.0.apk
)

cd ..
echo.
echo ============================================================
echo   PROJECT FINISHED! 🚀
echo.
echo   1. Start your server:  python start_server.bat
echo   2. Run the bot:       python run_bot.bat
echo   3. Install the APK:   fortress-options-v1.2.0.apk
echo.
echo   Happy Trading!
echo ============================================================
pause
