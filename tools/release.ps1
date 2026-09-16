# Снапшот текущей версии расширения в versions/vX.Y.Z + zip.
# Запуск: powershell -ExecutionPolicy Bypass -File tools\release.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'extension'
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$dest = Join-Path $root "versions\v$version"
$zip = Join-Path $root "versions\support-translator-v$version.zip"

if (Test-Path $dest) {
  Write-Host "Version v$version already exists in versions/. Bump 'version' in extension/manifest.json first." -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force (Join-Path $root 'versions') | Out-Null
Copy-Item $ext $dest -Recurse
Compress-Archive -Path (Join-Path $dest '*') -DestinationPath $zip
Write-Host "Released v$version -> $dest" -ForegroundColor Green
Write-Host "Zip: $zip"
