@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo       IRBY Dental Ledger - Android APK Builder
echo ========================================================

set "SDK=%LOCALAPPDATA%\Android\Sdk"
set "BUILD_TOOLS=%SDK%\build-tools\34.0.0"
set "PLATFORM_JAR=%SDK%\platforms\android-34\android.jar"
set "JAVA_BIN=C:\Program Files\Java\jdk-22\bin"

if not exist "%JAVA_BIN%\javac.exe" (
    echo Error: Java 22 not found at "%JAVA_BIN%"
    pause
    exit /b 1
)

set "JAVA_HOME=C:\Program Files\Java\jdk-22"
set "PATH=%JAVA_BIN%;%PATH%"

set "APP_DIR=%~dp0app"
set "SRC_DIR=%APP_DIR%\src\main"
set "BUILD_DIR=%APP_DIR%\build_cli"

echo 1. Cleaning and preparing build folders...
if exist "%BUILD_DIR%" rd /s /q "%BUILD_DIR%"
mkdir "%BUILD_DIR%\classes"
mkdir "%BUILD_DIR%\gen"

echo 2. Compiling resources with aapt2...
"%BUILD_TOOLS%\aapt2.exe" compile --dir "%SRC_DIR%\res" -o "%BUILD_DIR%\compiled_res.zip"
if errorlevel 1 goto error

echo 3. Linking resources with aapt2...
"%BUILD_TOOLS%\aapt2.exe" link -I "%PLATFORM_JAR%" --manifest "%SRC_DIR%\AndroidManifest.xml" -o "%BUILD_DIR%\unaligned.apk" --java "%BUILD_DIR%\gen" --auto-add-overlay "%BUILD_DIR%\compiled_res.zip"
if errorlevel 1 goto error

echo 4. Compiling Java classes with javac...
"%JAVA_BIN%\javac.exe" -source 8 -target 8 -cp "%PLATFORM_JAR%" -d "%BUILD_DIR%\classes" "%SRC_DIR%\java\com\irbyclinic\dentalledger\*.java" "%BUILD_DIR%\gen\com\irbyclinic\dentalledger\*.java"
if errorlevel 1 goto error

echo 5. Converting bytecode to DEX with d8...
cd /d "%BUILD_DIR%\classes"
"%BUILD_TOOLS%\d8.bat" --lib "%PLATFORM_JAR%" --release --min-api 24 --output "%BUILD_DIR%" com\irbyclinic\dentalledger\*.class
if errorlevel 1 goto error

echo 6. Packaging DEX into APK...
cd /d "%BUILD_DIR%"
"%JAVA_BIN%\jar.exe" -uf "unaligned.apk" "classes.dex"
if errorlevel 1 goto error

echo 7. Optimizing layout with zipalign...
"%BUILD_TOOLS%\zipalign.exe" -v -p 4 "%BUILD_DIR%\unaligned.apk" "%BUILD_DIR%\aligned.apk"
if errorlevel 1 goto error

echo 8. Generating keystore and signing APK...
if not exist "%BUILD_DIR%\debug.keystore" (
    "%JAVA_BIN%\keytool.exe" -genkeypair -v -keystore "%BUILD_DIR%\debug.keystore" -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android -dname "CN=Android Debug,O=Android,C=US"
)

"%BUILD_TOOLS%\apksigner.bat" sign --ks "%BUILD_DIR%\debug.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "%APP_DIR%\..\..\IRBY Dental Ledger.apk" "%BUILD_DIR%\aligned.apk"
if errorlevel 1 goto error

echo ========================================================
echo SUCCESS! APK generated at:
echo %APP_DIR%\..\..\IRBY Dental Ledger.apk
echo ========================================================
pause
exit /b 0

:error
echo [FAILED] An error occurred during the build.
pause
exit /b 1
