<#
.SYNOPSIS
    Read-only check of the local development environment.

.DESCRIPTION
    Reports OS, PowerShell, VS Code, Git, Node.js, npm, corepack and pnpm, and
    verifies the versions required by this repository. Agent CLIs (codex,
    claude, agy) and graft are reported for information only: they are not
    needed to build or test the project.

    The script changes nothing and never starts an AI session. For agent CLIs
    it runs at most `<cli> --version`.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/check-environment.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Manifest = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$PinnedPnpm = ($Manifest.packageManager -split '@')[1]
$MinNode = [version](($Manifest.engines.node -replace '[^\d\.]', ''))
$MinGit = [version]'2.27.0'   # cone-mode sparse checkout used by fetch-references.ps1

$script:Failures = 0

function Get-VersionOutput {
    param([string]$Command, [string[]]$Arguments = @('--version'))
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    try {
        $out = & $cmd.Source @Arguments 2>$null | Select-Object -First 1
        return [pscustomobject]@{ Path = $cmd.Source; Text = "$out".Trim() }
    }
    catch {
        return [pscustomobject]@{ Path = $cmd.Source; Text = '(version query failed)' }
    }
}

function ConvertTo-Version {
    param([string]$Text)
    if ($Text -match '(\d+)\.(\d+)\.(\d+)') { return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
    return $null
}

function Write-Check {
    param([string]$Name, [string]$Status, [string]$Detail)
    $color = switch ($Status) { 'ok' { 'Green' } 'info' { 'Gray' } 'warn' { 'Yellow' } default { 'Red' } }
    Write-Host ('{0,-10} {1,-5} {2}' -f $Name, $Status, $Detail) -ForegroundColor $color
    if ($Status -eq 'FAIL') { $script:Failures++ }
}

function Test-Required {
    param([string]$Name, [string]$Command, [version]$Minimum, [version]$Exact)
    $result = Get-VersionOutput $Command
    if (-not $result) { Write-Check $Name 'FAIL' 'not found on PATH'; return }
    $version = ConvertTo-Version $result.Text
    $detail = "$($result.Text)  [$($result.Path)]"
    if ($Exact -and $version -ne $Exact) { Write-Check $Name 'FAIL' "$detail - expected exactly $Exact"; return }
    if ($Minimum -and (-not $version -or $version -lt $Minimum)) { Write-Check $Name 'FAIL' "$detail - requires >= $Minimum"; return }
    Write-Check $Name 'ok' $detail
}

function Test-Optional {
    param([string]$Name, [string]$Command, [string]$Note)
    $result = Get-VersionOutput $Command
    if ($result) { Write-Check $Name 'info' "$($result.Text)  [$($result.Path)]" }
    else { Write-Check $Name 'info' "not on PATH ($Note)" }
}

$os = Get-CimInstance Win32_OperatingSystem
Write-Host "OS         $($os.Caption) $($os.Version) $env:PROCESSOR_ARCHITECTURE"
Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Write-Host ''
Write-Host 'Required'
Test-Required 'git' 'git' -Minimum $MinGit
Test-Required 'node' 'node' -Minimum $MinNode
Test-Required 'npm' 'npm'
Test-Required 'corepack' 'corepack'
Test-Required 'pnpm' 'pnpm' -Exact ([version]$PinnedPnpm)
Test-Required 'code' 'code'

Write-Host ''
Write-Host 'Optional (not needed to build or test)'
Test-Optional 'codex' 'codex' 'future Codex adapter'
Test-Optional 'claude' 'claude' 'future Claude Code adapter'
Test-Optional 'agy' 'agy' 'future Antigravity adapter'
Test-Optional 'graft' 'graft' 'optional local code index'

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) required check(s) failed. See docs/development.md." -ForegroundColor Red
    exit 1
}
Write-Host 'Environment OK.' -ForegroundColor Green
