<#
.SYNOPSIS
    Fetches the read-only reference repositories into references/ at pinned commits.

.DESCRIPTION
    Each reference is fetched with a shallow, blob-less partial clone of exactly one
    pinned commit. Large repositories use a cone-mode sparse checkout.

    The script never updates a reference automatically: an existing checkout at a
    different commit is reported and left untouched unless -Force is given.
    No script, hook or package manager from the fetched repositories is executed.

    To move a pin: edit the Sha below, update docs/reference-sources.md, then run
    with -Force -Only <name>.

.PARAMETER Only
    Restrict the fetch to the named references (e.g. -Only usturlab,codex-source).

.PARAMETER Force
    Delete and re-fetch checkouts that are not at the pinned commit.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/fetch-references.ps1
#>
[CmdletBinding()]
param(
    [string[]]$Only,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$References = @(
    @{
        Name   = 'usturlab'
        Url    = 'https://github.com/mdenesfe/usturlab'
        Sha    = '2607aa8d1b0724a9083fc66b7d087522fe468ddf'
        Sparse = $null
    },
    @{
        Name   = 'augani-agent-orchestrator'
        Url    = 'https://github.com/Augani/agent-orchestrator'
        Sha    = '8d9b897c49500e8e1b54ec8028352544db95618d'
        Sparse = $null
    },
    @{
        Name   = 'codex-source'
        Url    = 'https://github.com/openai/codex'
        Sha    = '8d9f6466ff0294785d56f55b1fe363d132fe4133'
        Sparse = @(
            'codex-rs/app-server',
            'codex-rs/app-server-protocol',
            'codex-rs/docs',
            'codex-rs/exec',
            'codex-rs/protocol',
            'docs',
            'sdk'
        )
    },
    @{
        Name   = 'vscode-extension-samples'
        Url    = 'https://github.com/microsoft/vscode-extension-samples'
        Sha    = '65c1c44800eeac6fb065a54823ee5ae62c79540a'
        Sparse = @(
            'helloworld-sample',
            'helloworld-test-cli-sample',
            'helloworld-test-sample',
            'webview-sample',
            'webview-view-sample'
        )
    }
)

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)]$GitArgs)
    # Flatten so that array arguments (sparse paths) become separate git arguments.
    $flat = @($GitArgs | ForEach-Object { $_ })
    & git @flat
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is not available on PATH.'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RefRoot = Join-Path $RepoRoot 'references'
New-Item -ItemType Directory -Force -Path $RefRoot | Out-Null

$failed = @()
foreach ($ref in $References) {
    if ($Only -and ($Only -notcontains $ref.Name)) { continue }

    $dir = Join-Path $RefRoot $ref.Name
    Write-Host "==> $($ref.Name) @ $($ref.Sha.Substring(0, 12))"

    try {
        if (Test-Path (Join-Path $dir '.git')) {
            $current = (& git -C $dir rev-parse HEAD 2>$null)
            if ($current -eq $ref.Sha) {
                if ($ref.Sparse) {
                    # The sparse path list is part of the pin: re-apply it (local, idempotent).
                    Invoke-Git -C $dir sparse-checkout set --cone $ref.Sparse
                }
                Write-Host '    already at pinned commit'
                continue
            }
            if (-not $Force) {
                Write-Warning "    checkout is at $current, not the pinned commit. Re-run with -Force to replace it."
                continue
            }
            Remove-Item -Recurse -Force -Path $dir
        }
        elseif (Test-Path $dir) {
            if (-not $Force) {
                Write-Warning "    $dir exists but is not a git checkout. Re-run with -Force to replace it."
                continue
            }
            Remove-Item -Recurse -Force -Path $dir
        }

        Invoke-Git init --quiet $dir
        Invoke-Git -C $dir config core.longpaths true
        Invoke-Git -C $dir config advice.detachedHead false
        Invoke-Git -C $dir remote add origin $ref.Url

        if ($ref.Sparse) {
            Invoke-Git -C $dir sparse-checkout set --cone $ref.Sparse
        }

        Invoke-Git -C $dir fetch --quiet --depth 1 --filter=blob:none origin $ref.Sha
        Invoke-Git -C $dir checkout --quiet FETCH_HEAD

        $head = (& git -C $dir rev-parse HEAD)
        if ($head -ne $ref.Sha) {
            throw "HEAD is $head, expected $($ref.Sha)"
        }
        Write-Host '    ok'
    }
    catch {
        Write-Warning "    failed: $_"
        $failed += $ref.Name
    }
}

if ($failed.Count -gt 0) {
    Write-Error "Failed references: $($failed -join ', ')"
    exit 1
}
