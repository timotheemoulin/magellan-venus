# Empaquette le site pour un hébergement mutualisé, avec la même disposition qu'un
# clone git dans le dossier web : dist/ (bundle Vite) + .htaccess + données de public/
# (tuiles, cartes globales, meta.json, names.json) à la racine.
#
# Usage :  pwsh tools/package.ps1            -> magellan-site.zip (site complet, ~1,7 Go)
#          pwsh tools/package.ps1 -AppOnly   -> magellan-app.zip (dist/ + .htaccess seulement,
#                                              pour une mise à jour sans retoucher aux tuiles)
#          pwsh tools/package.ps1 -NoBuild   (réutilise dist/ existant)
param([switch]$NoBuild, [switch]$AppOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $NoBuild) { npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué" } }

$stage = Join-Path $root 'site'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item -Recurse -Path 'dist' -Destination (Join-Path $stage 'dist')
Copy-Item -Path '.htaccess' -Destination $stage

if ($AppOnly) {
    $zip = Join-Path $root 'magellan-app.zip'
} else {
    foreach ($f in 'public/meta.json', 'public/names.json', 'public/tiles') {
        if (-not (Test-Path $f)) { throw "$f manquant : lancez tools/build_tiles.py et tools/build_names.py" }
    }
    Copy-Item -Recurse -Path 'public/*' -Destination $stage
    $zip = Join-Path $root 'magellan-site.zip'
}

if (Test-Path $zip) { Remove-Item $zip }
# Compress-Archive ignore les fichiers cachés : on passe par .NET pour inclure .htaccess.
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)
Remove-Item -Recurse -Force $stage

$size = (Get-Item $zip).Length
$label = if ($size -gt 10MB) { "$([math]::Round($size / 1MB)) Mo" } else { "$([math]::Round($size / 1KB)) Ko" }
Write-Host "Archive prête : $zip ($label)"
