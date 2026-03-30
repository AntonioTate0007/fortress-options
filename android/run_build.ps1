$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "C:\Users\antonio\AppData\Local\Android\Sdk"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Set-Location "C:\Users\antonio\Projects\opt bot - android\android"

$output = & cmd.exe /c "gradlew.bat assembleDebug 2>&1"
$output | Out-File -FilePath "C:\Users\antonio\Projects\opt bot - android\android\build_output.txt" -Encoding UTF8
$output
