$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path $repoRoot "public\menagerie"
$robotId = "franka_emika_panda"
$tmp = Join-Path $env:TEMP ("mujoco-menagerie-" + [guid]::NewGuid().ToString())

try {
    New-Item -ItemType Directory -Force $targetRoot | Out-Null
    git clone --filter=blob:none --depth 1 --sparse https://github.com/google-deepmind/mujoco_menagerie.git $tmp
    git -C $tmp sparse-checkout set $robotId

    $destination = Join-Path $targetRoot $robotId
    if (Test-Path $destination) {
        Remove-Item $destination -Recurse -Force
    }

    Copy-Item (Join-Path $tmp $robotId) $targetRoot -Recurse
    Write-Host "Synced $robotId assets to $destination"
}
finally {
    if (Test-Path $tmp) {
        Remove-Item $tmp -Recurse -Force
    }
}
