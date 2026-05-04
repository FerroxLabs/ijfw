# IJFW Windows-native installer (F4).
# PowerShell 5.1+ / PowerShell Core on Windows. No WSL required.
#
# Mirrors installer/src/install.js flow:
#   preflight -> resolve target -> clone/pull -> run scripts/install.sh via Git Bash
#   -> merge marketplace into %USERPROFILE%\.claude\settings.json -> summary.
#
# Usage:
#   Invoke-Expression (iwr https://raw.githubusercontent.com/TheRealSeanDonahoe/ijfw/main/installer/src/install.ps1).Content
#   or:
#   .\install.ps1 -Dir C:\Users\me\.ijfw -Branch main

[CmdletBinding()]
param(
  [string]$Dir = "",
  [string]$Branch = "main",
  [switch]$NoMarketplace,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$DEFAULT_REPO = "https://github.com/TheRealSeanDonahoe/ijfw.git"

function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  ... $msg" -ForegroundColor Gray }

function Test-Command($cmd) {
  try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Get-Target {
  if ($Dir) {
    $resolved = Resolve-Path -LiteralPath $Dir -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path } else { return $Dir }
  }
  if ($env:IJFW_HOME) { return $env:IJFW_HOME }
  return Join-Path $env:USERPROFILE ".ijfw"
}

function Invoke-Preflight {
  $issues = @()
  $node = if (Test-Command node) { (node --version) } else { $null }
  if (-not $node -or ([int]($node -replace 'v(\d+)\..*','$1') -lt 18)) {
    $issues += "Node 18+ unlocks IJFW (found $node). Grab it from https://nodejs.org and we'll pick up where you left off."
  }
  if (-not (Test-Command git))  { $issues += "Install Git for Windows (https://git-scm.com) and rerun -- it bundles everything we need." }
  if (-not (Resolve-GitBash)) { $issues += "IJFW needs Git Bash (ships with Git for Windows). Install Git for Windows and rerun -- takes 60 seconds." }
  return $issues
}

# Locate Git Bash explicitly. On Windows the plain `bash` command often
# resolves to WSL's bash, which fails with 'No such file or directory' when
# no Linux distro is installed. Git for Windows ships bash.exe alongside
# git.exe under <git-root>\bin\ (or \usr\bin\), so derive it from git's path.
function Resolve-GitBash {
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCmd) {
    $gitDir = Split-Path -Parent $gitCmd.Source
    $candidates = @(
      (Join-Path $gitDir 'bash.exe'),
      (Join-Path (Split-Path -Parent $gitDir) 'bin\bash.exe'),
      (Join-Path (Split-Path -Parent $gitDir) 'usr\bin\bash.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  }
  foreach ($c in @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files\Git\usr\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
  )) { if (Test-Path $c) { return $c } }
  return $null
}

function Invoke-CloneOrPull($target, $branch) {
  if (-not (Test-Path $target)) {
    # Fresh install.
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    & git clone --depth 1 --branch $branch $DEFAULT_REPO $target
    if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
    return "cloned"
  }

  # Upgrade path.
  $hasGit = Test-Path (Join-Path $target ".git")
  if ($hasGit) {
    & git -C $target remote get-url origin 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      # fetch + hard checkout avoids ff-only failures from local divergence.
      & git -C $target fetch --depth 1 origin $branch
      if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
      & git -C $target checkout -f FETCH_HEAD
      if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
      return "updated"
    }
  }

  # Broken repo or no origin: backup user data, re-clone, restore.
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $backupDir = "$target.bak.$ts"
  Rename-Item -LiteralPath $target -NewName $backupDir
  try {
    & git clone --depth 1 --branch $branch $DEFAULT_REPO $target
    if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
    foreach ($item in @('memory', 'sessions', 'install.log', '.session-counter')) {
      $src = Join-Path $backupDir $item
      if (Test-Path $src) {
        $dst = Join-Path $target $item
        if (Test-Path $dst) { Remove-Item -Recurse -Force -LiteralPath $dst }
        Move-Item -LiteralPath $src -Destination $dst
      }
    }
    Remove-Item -Recurse -Force -LiteralPath $backupDir
    return "updated"
  } catch {
    if (Test-Path $target) { Remove-Item -Recurse -Force -LiteralPath $target }
    Rename-Item -LiteralPath $backupDir -NewName $target
    throw
  }
}

function Invoke-InstallScript($target) {
  $script = Join-Path $target "scripts\install.sh"
  if (-not (Test-Path $script)) { throw "The installer script is not at $script yet. Run the full install from a fresh clone." }
  $gitBash = Resolve-GitBash
  if (-not $gitBash) { throw "IJFW needs Git Bash to complete setup. Install Git for Windows (includes bash.exe) and rerun." }
  Push-Location $target
  try {
    $env:IJFW_NONINTERACTIVE = if ($env:CI -or $Yes) { "1" } else { "" }
    # Let the PS wrapper own the final closer so Merge-Marketplace output
    # lands above it. Bash skips its "Full log" line when this is set.
    $env:IJFW_SKIP_CLOSER = "1"
    & $gitBash "./scripts/install.sh"
    if ($LASTEXITCODE -ne 0) { throw "scripts/install.sh exited $LASTEXITCODE." }
  } finally {
    Pop-Location
    Remove-Item Env:\IJFW_SKIP_CLOSER -ErrorAction SilentlyContinue
  }
}

function ConvertTo-Hashtable($obj) {
  # PS 5.1 compatibility: ConvertFrom-Json's -AsHashtable is PS 7+ only.
  # Walk the PSCustomObject tree manually into hashtables + arrays.
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    $h = @{}
    foreach ($k in $obj.Keys) { $h[$k] = ConvertTo-Hashtable $obj[$k] }
    return $h
  }
  if ($obj -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
    return $h
  }
  if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
    $out = @()
    foreach ($item in $obj) { $out += ,(ConvertTo-Hashtable $item) }
    return ,$out
  }
  return $obj
}

function ConvertFrom-Jsonc($raw) {
  # State-machine JSONC cleaner: strips // line comments, /* block comments */,
  # and trailing commas before } or ], but only when NOT inside a string.
  # The regex version we shipped earlier mangled files whose string values
  # contained // or /* patterns. This implementation walks the text char by
  # char with a tiny state machine -- no regex false-positives.
  if (-not $raw) { return $raw }
  if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }

  $sb = New-Object System.Text.StringBuilder
  $len = $raw.Length
  $i = 0
  $inString = $false
  $escape = $false

  while ($i -lt $len) {
    $ch = $raw[$i]
    if ($inString) {
      [void]$sb.Append($ch)
      if ($escape) { $escape = $false }
      elseif ($ch -eq '\') { $escape = $true }
      elseif ($ch -eq '"') { $inString = $false }
      $i++
      continue
    }
    if ($ch -eq '"') { $inString = $true; [void]$sb.Append($ch); $i++; continue }
    if ($ch -eq '/' -and $i + 1 -lt $len) {
      $next = $raw[$i + 1]
      if ($next -eq '/') {
        while ($i -lt $len -and $raw[$i] -ne "`n") { $i++ }
        continue
      }
      if ($next -eq '*') {
        $i += 2
        while ($i + 1 -lt $len -and -not ($raw[$i] -eq '*' -and $raw[$i + 1] -eq '/')) { $i++ }
        $i += 2
        continue
      }
    }
    [void]$sb.Append($ch)
    $i++
  }

  # Strip trailing commas. Safe to do as a second regex pass now that strings
  # and comments are out of the way.
  $intermediate = $sb.ToString()
  return ($intermediate -replace ',(\s*[}\]])','$1')
}

function Merge-Marketplace {
  param(
    [string]$IjfwHome  # Install root; the plugin lives at "$IjfwHome\claude".
  )
  $settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
  $settingsDir = Split-Path -Parent $settingsPath
  if (-not (Test-Path $settingsDir)) { New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null }
  if (-not $IjfwHome) { $IjfwHome = Join-Path $env:USERPROFILE ".ijfw" }
  $pluginPath = Join-Path $IjfwHome "claude"

  $settings = @{}
  if (Test-Path $settingsPath) {
    $raw = Get-Content -Raw -LiteralPath $settingsPath
    $cleaned = ConvertFrom-Jsonc $raw
    try {
      $parsed = ConvertFrom-Json $cleaned -ErrorAction Stop
      $settings = ConvertTo-Hashtable $parsed
      if ($null -eq $settings) { $settings = @{} }
    } catch {
      # Graceful fallback: back up the unparseable file, surface the manual
      # next step, return without throwing so the rest of the install stands.
      $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
      $backup = "$settingsPath.bak.marketplace.$ts"
      Copy-Item -LiteralPath $settingsPath -Destination $backup -Force
      Write-Host "  ==> HEADS UP" -ForegroundColor Yellow -NoNewline
      Write-Host "  your Claude settings.json is not valid JSON/JSONC" -ForegroundColor DarkGray
      Write-Host "      Backed up to $backup" -ForegroundColor DarkGray
      Write-Host "      The two /plugin commands above still complete the install." -ForegroundColor DarkGray
      Write-Host ""
      return $false
    }
  }
  if (-not $settings.ContainsKey('extraKnownMarketplaces')) { $settings['extraKnownMarketplaces'] = @{} }
  # Self-heal: write the directory source matching the actual install. Prior
  # installs (<= 1.2.6) wrote a github source pointing at TheRealSeanDonahoe/
  # ijfw, but Claude Code never clones that repo into its marketplaces cache,
  # so the entry resolved to "Marketplace file not found". Idempotent.
  $settings.extraKnownMarketplaces['ijfw'] = @{ source = @{ source = 'directory'; path = $pluginPath } }
  if (-not $settings.ContainsKey('enabledPlugins')) { $settings['enabledPlugins'] = @{} }
  # Opportunistically clean up the legacy key written by v1.0.0-1.0.2.
  if ($settings.enabledPlugins.ContainsKey('ijfw-core@ijfw')) {
    $settings.enabledPlugins.Remove('ijfw-core@ijfw')
  }
  $settings.enabledPlugins['ijfw@ijfw'] = $true

  $tmp = "$settingsPath.tmp"
  $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -Force -LiteralPath $tmp -Destination $settingsPath
  return $true
}

# --- main ---
$issues = Invoke-Preflight
if ($issues.Count -gt 0) {
  Write-Host "Preflight:" -ForegroundColor Yellow
  foreach ($i in $issues) { Write-Host "  - $i" }
  exit 1
}

$target = Get-Target

# scripts/install.sh owns the summary (Live now / Standing by / next step).
# Keep clone/pull output suppressed so the final banner reads clean.
Invoke-CloneOrPull $target $Branch | Out-Null

Invoke-InstallScript $target

if (-not $NoMarketplace) {
  # Best-effort: returns $true on success, prints its own message on fallback.
  # Pass the resolved install root so the marketplace path matches reality
  # for both default and --dir installs.
  [void](Merge-Marketplace -IjfwHome $target)
}

$log = Join-Path $env:USERPROFILE ".ijfw\install.log"
Write-Host "  Full log   $log" -ForegroundColor DarkGray
Write-Host ""
