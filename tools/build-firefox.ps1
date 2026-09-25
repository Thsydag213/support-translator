# Сборка пакета для Firefox из extension/: manifest под Gecko (без service worker и offscreen).
# Chrome, Edge и Safari используют папку extension/ как есть.
# Запуск: powershell -ExecutionPolicy Bypass -File tools\build-firefox.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'extension'
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$dest = Join-Path $root "dist\firefox-v$version"
$zip = Join-Path $root "dist\support-translator-firefox-v$version.zip"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
Copy-Item $ext $dest -Recurse

# Firefox: фоновый скрипт вместо service worker, offscreen API нет
$m = Get-Content (Join-Path $dest 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$m.PSObject.Properties.Remove('minimum_chrome_version')
$m.background = [ordered]@{ scripts = @('background.js'); type = 'module' }
$m.permissions = @($m.permissions | Where-Object { $_ -ne 'offscreen' })
$m | Add-Member -NotePropertyName 'browser_specific_settings' -NotePropertyValue ([ordered]@{
  gecko = [ordered]@{ id = 'support-translator@local.extension'; strict_min_version = '128.0' }
}) -Force
[IO.File]::WriteAllText((Join-Path $dest 'manifest.json'), ($m | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
Remove-Item (Join-Path $dest 'offscreen') -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $dest '*') -DestinationPath $zip
Write-Host "Firefox package v$version -> $dest" -ForegroundColor Green
Write-Host "Zip: $zip"
