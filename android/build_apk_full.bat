@echo off
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "ANDROID_HOME=C:\Users\antonio\AppData\Local\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"

cd /d "C:\Users\antonio\Projects\opt bot - android\android"

echo Building Fortress Options APK...
echo JAVA_HOME=%JAVA_HOME%
echo ANDROID_HOME=%ANDROID_HOME%
echo.

call gradlew.bat assembleDebug

echo.
echo Build finished with exit code: %ERRORLEVEL%
