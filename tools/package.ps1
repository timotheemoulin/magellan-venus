# Construit le site statique et l'empaquette dans une archive prête à déposer
# sur un hébergement mutualisé (Infomaniak) : dist/ + public/ (tuiles, cartes,
# meta.json, names.json) + deploy/.htaccess.
#
# Usage :  pwsh tools/package.ps1            -> magellan-site.zip (site complet)
#          pwsh tools/package.ps1 -AppOnly   -> magellan-app.zip (index.html + assets/ seulement,
#                                              pour une mise à jour sans retoucher aux tuiles)
#          pwsh tools/package.ps1 -NoBuild   (réutilise dist/ existant)
param([switch]$NoBuild, [switch]$AppOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $NoBuild) { npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué" } }

if ($AppOnly) {
    $zip = Join-Path $root 'magellan-app.zip'
    if (Test-Path $zip) { Remove-Item $zip }
    [IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $root 'dist'), $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Write-Host "Archive prête : $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) Ko)"
    return
}
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
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)
Remove-Item -Recurse -Force $stage

$size = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "Archive prête : $zip ($size Mo)"
