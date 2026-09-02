# Construit le site statique et l'empaquette dans une archive prête à déposer
# sur un hébergement mutualisé (Infomaniak) : dist/ + public/ (tuiles, cartes,
# meta.json, names.json) + deploy/.htaccess.
#
# Usage :  pwsh tools/package.ps1            -> magellan-site.zip
#          pwsh tools/package.ps1 -NoBuild   (réutilise dist/ existant)
param([switch]$NoBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $NoBuild) { npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué" } }
foreach ($f in 'public/meta.json', 'public/names.json', 'public/tiles') {
    if (-not (Test-Path $f)) { throw "$f manquant : lancez tools/build_tiles.py et tools/build_names.py" }
}

$stage = Join-Path $root 'site'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item -Recurse -Path 'dist/*' -Destination $stage
Copy-Item -Recurse -Path 'public/*' -Destination $stage
Copy-Item -Path 'deploy/.htaccess' -Destination $stage

$zip = Join-Path $root 'magellan-site.zip'
if (Test-Path $zip) { Remove-Item $zip }
# Compress-Archive ignore les fichiers cachés : on passe par .NET pour inclure .htaccess.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)
Remove-Item -Recurse -Force $stage

$size = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "Archive prête : $zip ($size Mo)"
