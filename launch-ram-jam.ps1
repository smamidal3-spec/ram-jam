param(
    [int]$Port = 3001,
    [string]$MetricsAddress = "127.0.0.1:20241"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Stop-ByCommandLine {
    param(
        [string]$ProcessName,
        [string]$Pattern
    )

    $procs = Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $Pattern
    }

    foreach ($proc in $procs) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped $ProcessName PID $($proc.ProcessId)"
        } catch {
            Write-Host "Could not stop $ProcessName PID $($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Wait-ForPort {
    param(
        [int]$LocalPort,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $listen = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
        if ($listen) {
            return $true
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Get-TunnelUrlFromLogs {
    param([string[]]$LogPaths)

    foreach ($path in $LogPaths) {
        if (-not (Test-Path $path)) {
            continue
        }

        $match = Select-String -Path $path -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches | Select-Object -Last 1
        if ($match -and $match.Matches.Count -gt 0) {
            return $match.Matches[$match.Matches.Count - 1].Value
        }
    }

    return $null
}

function Get-TunnelUrlFromMetrics {
    param([string]$MetricsAddr)

    try {
        $metrics = & curl.exe -s "http://$MetricsAddr/metrics"
        $m = [regex]::Match($metrics, "https://[a-z0-9-]+\.trycloudflare\.com")
        if ($m.Success) {
            return $m.Value
        }
    } catch {
        return $null
    }
    return $null
}

function Get-SessionPath {
    param([int]$LocalPort)

    try {
        $headers = & curl.exe -s -I "http://localhost:$LocalPort/"
        $all = $headers -join "`n"
        $m = [regex]::Match($all, "(?im)^Location:\s*(/session/[A-Z0-9]+)\s*$")
        if ($m.Success) {
            return $m.Groups[1].Value
        }
    } catch {
        return "/"
    }
    return "/"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js not found in PATH."
}

$cloudflaredExe = Join-Path $scriptDir "cloudflared.exe"
if (-not (Test-Path $cloudflaredExe)) {
    $cloudflaredExe = "cloudflared"
}

Write-Host "Cleaning old Ram Jam processes..."
Stop-ByCommandLine -ProcessName "node.exe" -Pattern "server\.js"
Stop-ByCommandLine -ProcessName "cloudflared.exe" -Pattern "tunnel\s+--url\s+http://(localhost|127\.0\.0\.1):$Port"

Write-Host "Starting server on port $Port..."
$env:PORT = "$Port"
$serverProc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $scriptDir -PassThru -WindowStyle Hidden

if (-not (Wait-ForPort -LocalPort $Port -TimeoutSeconds 20)) {
    throw "Server did not start on port $Port."
}

$tunnelLog = Join-Path $scriptDir "launcher-tunnel.log"
$tunnelErrLog = Join-Path $scriptDir "launcher-tunnel.err.log"
if (Test-Path $tunnelLog) {
    Remove-Item $tunnelLog -Force
}
if (Test-Path $tunnelErrLog) {
    Remove-Item $tunnelErrLog -Force
}

Write-Host "Starting Cloudflare quick tunnel..."
$tunnelArgs = @("tunnel", "--url", "http://localhost:$Port", "--ha-connections", "1", "--metrics", $MetricsAddress)
$tunnelProc = Start-Process -FilePath $cloudflaredExe -ArgumentList $tunnelArgs -WorkingDirectory $scriptDir -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErrLog -PassThru -WindowStyle Hidden

$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
    $tunnelUrl = Get-TunnelUrlFromLogs -LogPaths @($tunnelLog, $tunnelErrLog)
    if (-not $tunnelUrl) {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $tunnelUrl) {
    $tunnelUrl = Get-TunnelUrlFromMetrics -MetricsAddr $MetricsAddress
}

if (-not $tunnelUrl) {
    throw "Tunnel started but URL not found. Check launcher-tunnel.log."
}

$sessionPath = Get-SessionPath -LocalPort $Port
$inviteUrl = "$tunnelUrl$sessionPath"

Write-Output ""
Write-Output "Ram Jam is live."
Write-Output "Server PID : $($serverProc.Id)"
Write-Output "Tunnel PID : $($tunnelProc.Id)"
Write-Output "Local URL  : http://localhost:$Port$sessionPath"
Write-Output "Invite URL : $inviteUrl"
Write-Output ""
Write-Output "Send the Invite URL to your friend."
