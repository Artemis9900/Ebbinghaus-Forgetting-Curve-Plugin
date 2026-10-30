# Install dsh-ebbinghaus into a dsh profile.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI, so no Chinese here.
param(
  [string]$Profile = "desktop",
  [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE ".dsh"
}
$profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile

Write-Host "dsh home : $DshHome"
Write-Host "profile  : $Profile"
Write-Host "target   : $profileDir"

if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: profile directory not found. Is dsh installed and has this profile been used?" -ForegroundColor Red
  exit 1
}

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path (Join-Path $profileDir "node_modules") "dsh-ebbinghaus"

Write-Host "[1/3] copying package -> $dest"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item $src $dest -Recurse -Force

# If the bundle also lives in the shared plugins dir, keep a copy there too
# (Link-style bundles in other profiles reference it).
$sharedPlugins = Join-Path (Join-Path $DshHome "plugins") "dsh-ebbinghaus"
if (Test-Path (Split-Path $sharedPlugins)) {
  Write-Host "      also mirroring to $sharedPlugins"
  if (Test-Path $sharedPlugins) { Remove-Item $sharedPlugins -Recurse -Force }
  Copy-Item $src $sharedPlugins -Recurse -Force
}

$pkgFile = Join-Path $profileDir "package.json"
Write-Host "[2/3] updating $pkgFile"

$raw = Get-Content $pkgFile -Raw
$pkg = $raw | ConvertFrom-Json

function Ensure-Prop($obj, $name) {
  if (-not $obj.PSObject.Properties.Name.Contains($name)) {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
}

if (-not $pkg.PSObject.Properties.Name.Contains("dsh")) {
  $pkg | Add-Member -NotePropertyName "dsh" -NotePropertyValue ([pscustomobject]@{}) -Force
}
Ensure-Prop $pkg "dependencies"
if (-not $pkg.dsh.PSObject.Properties.Name.Contains("profile")) {
  $pkg.dsh | Add-Member -NotePropertyName "profile" -NotePropertyValue ([pscustomobject]@{}) -Force
}
Ensure-Prop $pkg.dsh.profile "bundles"

$depValue = "file:./node_modules/dsh-ebbinghaus"
if ($pkg.dependencies.PSObject.Properties.Name.Contains("dsh-ebbinghaus")) {
  $pkg.dependencies."dsh-ebbinghaus" = $depValue
} else {
  $pkg.dependencies | Add-Member -NotePropertyName "dsh-ebbinghaus" -NotePropertyValue $depValue -Force
}

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles += @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains "dsh-ebbinghaus") { $bundles += "dsh-ebbinghaus" }
$pkg.dsh.profile.bundles = $bundles

[System.IO.File]::WriteAllText($pkgFile, ($pkg | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[3/3] done"
Write-Host ""
Write-Host "Bundles now:" -ForegroundColor Green
foreach ($b in $bundles) { Write-Host "  - $b" }
Write-Host ""
Write-Host "NEXT: fully quit DeepSeek Harness and start it again." -ForegroundColor Yellow
Write-Host "      On restart ask the agent to run ebb_stats to confirm it loaded."
Write-Host ""
Write-Host "WARNING: after this, avoid 'dsh plugin add' - the plugin manager in 0.2.1"
Write-Host "         may rewrite the bundles list and drop entries."
