$ErrorActionPreference = "Stop"

$port = 3000
$listeners = @()

try {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique
}
catch {
    $lines = netstat -ano -p tcp | Select-String ":$port"
    foreach ($line in $lines) {
        $text = ($line.ToString() -replace "\s+", " ").Trim()
        if ($text -match "LISTENING (\d+)$") {
            $listeners += [int]$Matches[1]
        }
    }
    $listeners = $listeners | Select-Object -Unique
}

foreach ($listenerPid in $listeners) {
    if (-not $listenerPid -or $listenerPid -le 0 -or $listenerPid -eq $PID) {
        continue
    }

    try {
        $process = Get-Process -Id $listenerPid -ErrorAction Stop
        Write-Host "Stopping process $listenerPid ($($process.ProcessName)) on port $port..."
        Stop-Process -Id $listenerPid -Force -ErrorAction Stop
    }
    catch {
        Write-Warning ("Failed to stop process {0} on port {1}: {2}" -f $listenerPid, $port, $_.Exception.Message)
    }
}
