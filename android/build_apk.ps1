$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\antonio\AppData\Local\Android\Sdk"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Set-Location "C:\Users\antonio\Projects\opt bot - android\android"
Write-Host "Java: $env:JAVA_HOME"
Write-Host "SDK:  $env:ANDROID_HOME"
Write-Host ""

& ".\gradlew.bat" assembleDebug
