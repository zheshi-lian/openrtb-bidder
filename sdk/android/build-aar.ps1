#!/usr/bin/env pwsh
# Build AppLink ADX Android SDK -> release AAR
# Usage: pwsh -File ./build-aar.ps1
# Output: build/outputs/aar/applink-adsdk-release.aar
# NOTE: keep this file ASCII-only so Windows PowerShell 5.1 (which reads .ps1 as
# ANSI without a BOM) never garbles the output.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 1) Locate a JDK
$java = $null
if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
  $java = Join-Path $env:JAVA_HOME 'bin\java.exe'
} elseif (Get-Command java -ErrorAction SilentlyContinue) {
  $java = (Get-Command java).Source
}
if (-not $java) {
  Write-Host '[ERROR] JDK not found. Install JDK 17 and set JAVA_HOME, then retry.' -ForegroundColor Red
  exit 1
}
Write-Host "[OK] JDK: $java"

# 2) Locate the Android SDK
$sdk = $null
if ($env:ANDROID_HOME) { $sdk = $env:ANDROID_HOME }
elseif ($env:ANDROID_SDK_ROOT) { $sdk = $env:ANDROID_SDK_ROOT }
else { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) {
  Write-Host "[ERROR] Android SDK not found (tried: $sdk). Install it and set ANDROID_HOME." -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Android SDK: $sdk"

# 3) Build (prefer the Gradle wrapper, fall back to a system Gradle)
Set-Location $root
$gradlewBat = Join-Path $root 'gradlew.bat'
$gradlewUnix = Join-Path $root 'gradlew'
if (Test-Path $gradlewBat) { & $gradlewBat assembleRelease --no-daemon }
elseif (Test-Path $gradlewUnix) { & $gradlewUnix assembleRelease --no-daemon }
else { gradle assembleRelease --no-daemon }

# 4) Report the artifact
$buildDir = Join-Path $root 'build'
$aar = Get-ChildItem -Recurse -Filter '*-release.aar' -Path $buildDir -ErrorAction SilentlyContinue | Select-Object -First 1
if ($aar) {
  Write-Host ('[DONE] AAR: ' + $aar.FullName) -ForegroundColor Green
} else {
  Write-Host '[WARN] No AAR produced. Check the Gradle log above.' -ForegroundColor Yellow
  exit 1
}
