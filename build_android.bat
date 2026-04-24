@echo off
title Fortress Options - Build Signed Release APK
color 0B
setlocal enableextensions

echo ============================================================
echo   FORTRESS OPTIONS - Release APK Builder
echo ============================================================
echo.

:: -- Sanity check: Node --
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause ^& exit /b 1
)

:: -- Sanity check: Java/Android SDK --
if "%ANDROID_HOME%"=="" (
    if "%ANDROID_SDK_ROOT%"=="" (
        echo WARN: ANDROID_HOME / ANDROID_SDK_ROOT not set.
        echo       Gradle will look in the default location ^(may fail^).
        echo.
    )
)

:: -- 1. npm install --
echo [1/5] Installing npm dependencies...
call npm install
if errorlevel 1 ( echo FAILED at npm install ^& pause ^& exit /b 1 )

:: -- 2. Vite build (React app) --
echo.
echo [2/5] Building React app with Vite...
call npm run build
if errorlevel 1 ( echo FAILED at vite build ^& pause ^& exit /b 1 )

:: -- 3. Capacitor sync --
if not exist android (
    echo.
    echo [3/5] Adding Android platform...
    call npx cap add android
) else (
    echo.
    echo [3/5] Syncing dist/ to android assets...
    call npx cap sync android
)
if errorlevel 1 ( echo FAILED at cap sync ^& pause ^& exit /b 1 )

:: -- 4. Gradle assembleRelease (signed APK) --
echo.
echo [4/5] Building signed release APK with Gradle...
pushd android
call gradlew.bat assembleRelease
set GRADLE_RC=%ERRORLEVEL%
popd
if not "%GRADLE_RC%"=="0" (
    echo.
    echo Gradle build failed ^(rc=%GRADLE_RC%^). Common causes:
    echo   - ANDROID_HOME not set or pointing at the wrong SDK
    echo   - Java JDK 17+ not on PATH
    echo   - fortress-release.keystore missing under android\
    pause ^& exit /b 1
)

:: -- 5. Copy the APK out to the project root --
set APK_SRC=android\app\build\outputs\apk\release\app-release.apk
if not exist "%APK_SRC%" (
    echo.
    echo ERROR: expected APK not found at %APK_SRC%
    pause ^& exit /b 1
)
echo.
echo [5/5] Copying APK to project root as fortress-options.apk...
copy /Y "%APK_SRC%" "fortress-options.apk" >nul
if errorlevel 1 ( echo Copy failed. ^& pause ^& exit /b 1 )

echo.
echo ============================================================
echo   DONE -- fortress-options.apk is ready at the project root.
echo ============================================================
echo.
echo Sideload it onto a phone with:
echo   adb install -r fortress-options.apk
echo.
pause
