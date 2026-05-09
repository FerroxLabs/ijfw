# IJFW Windows-native installer (F4).
# PowerShell 5.1+ / PowerShell Core on Windows. No WSL required.
#
# Mirrors installer/src/install.js flow:
#   preflight -> resolve target -> clone/pull -> run scripts/install.sh via Git Bash
#   -> merge marketplace into %USERPROFILE%\.claude\settings.json -> summary.
#
# Usage:
#   Invoke-Expression (iwr https://gitlab.com/therealseandonahoe/ijfw/-/raw/main/installer/src/install.ps1).Content
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
$DEFAULT_REPO = "https://gitlab.com/therealseandonahoe/ijfw.git"

function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  ... $msg" -ForegroundColor Gray }

function Test-Command($cmd) {
  try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Get-Target {
  if ($Dir) {
    # Expand %APPDATA%-style env vars and leading ~ before resolving.
    $path = [System.Environment]::ExpandEnvironmentVariables($Dir)
    if ($path -like '~*') { $path = $path -replace '^~', $env:USERPROFILE }
    $resolved = Resolve-Path -LiteralPath $path -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path } else { return $path }
  }
  if ($env:IJFW_HOME) {
    $path = [System.Environment]::ExpandEnvironmentVariables($env:IJFW_HOME)
    if ($path -like '~*') { $path = $path -replace '^~', $env:USERPROFILE }
    return $path
  }
  return Join-Path $env:USERPROFILE ".ijfw"
}

function Invoke-Preflight {
  $issues = @()
  $node = if (Test-Command node) { (node --version) } else { $null }
  if (-not $node -or ([int]($node -replace 'v(\d+)\..*','$1') -lt 18)) {
    $issues += "Node 18+ unlocks IJFW (found $node). Grab it from https://nodejs.org and we'll pick up where you left off."
  }
  if (-not (Test-Command git))  { $issues += "IJFW needs git (used to clone the source repo). Install: winget install --id Git.Git -e --source winget" }
  # Bash is no longer required (v1.3.0 -- installer is Node-native).
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
    $currentOriginRaw = & git -C $target remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) {
      # Self-heal stale origin URLs across host migrations (1.2.9 parity with install.js).
      # Without this, Windows users on the pre-GitLab origin still 404 on every upgrade.
      $currentOrigin = ($currentOriginRaw | Out-String).Trim()
      if ($currentOrigin -and $currentOrigin -ne $DEFAULT_REPO) {
        Write-Host "  origin migration: $currentOrigin -> $DEFAULT_REPO"
        & git -C $target remote set-url origin $DEFAULT_REPO
      }
      # fetch + hard checkout avoids ff-only failures from local divergence.
      & git -C $target fetch --depth 1 origin $branch
      if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
      & git -C $target checkout -f FETCH_HEAD
      if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
      return "updated"
    }
  }

  # Broken repo or no origin: backup user data, re-clone, restore.
  # Rename-Item -NewName requires a leaf name; Move-Item -Destination accepts an
  # absolute path. Using Rename-Item with an absolute path silently lost user data
  # on Windows pre-1.2.9 because PowerShell rejected the call.
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $backupDir = "$target.bak.$ts"
  Move-Item -LiteralPath $target -Destination $backupDir -Force
  try {
    & git clone --depth 1 --branch $branch $DEFAULT_REPO $target
    if ($LASTEXITCODE -ne 0) { throw "Could not reach the IJFW repo (exit $LASTEXITCODE). Check your network connection and retry." }
    foreach ($item in @('memory', 'sessions', 'install.log', '.session-counter')) {
      $src = Join-Path $backupDir $item
      if (Test-Path $src) {
        $dst = Join-Path $target $item
        if (Test-Path $dst) { Remove-Item -Recurse -Force -LiteralPath $dst }
        Move-Item -LiteralPath $src -Destination $dst -Force
      }
    }
    Remove-Item -Recurse -Force -LiteralPath $backupDir
    return "updated"
  } catch {
    if (Test-Path $target) { Remove-Item -Recurse -Force -LiteralPath $target }
    Move-Item -LiteralPath $backupDir -Destination $target -Force
    throw
  }
}

function Invoke-InstallScript($target) {
  # v1.3.0: hand off to the Node-native installer (installer/src/install.js).
  # No more bash dependency. Identical code path on every platform.
  $entry = Join-Path $target "installer\src\install.js"
  if (-not (Test-Path $entry)) { throw "The installer entry is not at $entry. Run the full install from a fresh clone." }
  $priorIjfwHome = $env:IJFW_HOME
  $env:IJFW_HOME = $target
  Push-Location $target
  try {
    $env:IJFW_NONINTERACTIVE = if ($env:CI -or $Yes) { "1" } else { "" }
    $env:IJFW_SKIP_CLOSER = "1"
    & node $entry
    if ($LASTEXITCODE -ne 0) { throw "Node installer exited $LASTEXITCODE." }
  } finally {
    Pop-Location
    Remove-Item Env:\IJFW_SKIP_CLOSER -ErrorAction SilentlyContinue
    if ($priorIjfwHome) { $env:IJFW_HOME = $priorIjfwHome } else { Remove-Item Env:\IJFW_HOME -ErrorAction SilentlyContinue }
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

function Remove-StalePosixLaunchers {
  # Pre-1.2.7 installs (and any install run from WSL) wrote POSIX bash
  # launchers into ~/.local/bin/ even on Windows. Windows can't execute
  # files without an extension, so PATH lookup finds them ahead of npm's
  # ijfw.cmd shim and Windows hands them to Notepad as plain text.
  #
  # On every install, sweep ~/.local/bin/ for the five known POSIX
  # launchers. Defensive: only remove files whose first line is a shebang
  # ("#!") so we never delete user content or Windows binaries that
  # happened to share a name.
  $localBin = Join-Path $env:USERPROFILE ".local\bin"
  if (-not (Test-Path $localBin)) { return }

  $launchers = @("ijfw", "ijfw-dashboard", "ijfw-dispatch-plan", "ijfw-memorize", "ijfw-memory")
  $removed = 0
  foreach ($name in $launchers) {
    $path = Join-Path $localBin $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try {
      $first = (Get-Content -LiteralPath $path -TotalCount 1 -ErrorAction Stop)
      if ($first -and $first.StartsWith("#!")) {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        $removed++
      }
    } catch {
      # Best-effort: keep going on locked / inaccessible files.
    }
  }
  if ($removed -gt 0) {
    Write-Ok "Cleared $removed stale POSIX launcher$(if ($removed -ne 1) { 's' }) from $localBin (npm shim now wins PATH)"
  }
}

function Provision-Plugin {
  param(
    [string]$Src,   # Source dir inside repo (relative to $IjfwHome), e.g. "wayland\plugins\ijfw"
    [string]$Dst,   # Absolute destination path, e.g. "$env:USERPROFILE\.wayland\plugins\ijfw"
    [string]$IjfwHome
  )
  $srcPath = Join-Path $IjfwHome $Src
  if (-not (Test-Path $srcPath)) {
    Write-Info "Plugin source not found at $srcPath -- skipping."
    return
  }
  New-Item -ItemType Directory -Force -Path $Dst | Out-Null
  foreach ($srcItem in (Get-ChildItem -LiteralPath $srcPath -Recurse -File)) {
    $rel = $srcItem.FullName.Substring($srcPath.Length).TrimStart('\','/')
    $dstItem = Join-Path $Dst $rel
    $dstDir = Split-Path -Parent $dstItem
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    $srcMtime = $null
    $dstMtime = $null
    try {
      if (Test-Path $srcItem.FullName) { $srcMtime = (Get-Item $srcItem.FullName -ErrorAction Stop).LastWriteTime }
      if (Test-Path $dstItem)          { $dstMtime = (Get-Item $dstItem          -ErrorAction Stop).LastWriteTime }
    } catch {
      # File watcher race / lock / OneDrive offline -- treat as new install
      $dstMtime = $null
    }
    if ($null -ne $dstMtime -and $null -ne $srcMtime -and $dstMtime -gt $srcMtime) {
      # User has modified the destination; back it up before overwriting.
      $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $dstItem "$dstItem.user-bak.$ts" -Force -ErrorAction SilentlyContinue
    }
    Copy-Item $srcItem.FullName $dstItem -Force
    # Preserve source mtime so next install doesn't mistake our copy for a user edit.
    try { (Get-Item $dstItem -ErrorAction Stop).LastWriteTime = $srcItem.LastWriteTime } catch {}
  }
}

function Merge-PluginsEnabled {
  param(
    [string]$ConfigPath  # Full path to ~/.hermes/config.yaml
  )
  $pluginName = "ijfw"
  $configDir = Split-Path -Parent $ConfigPath

  # Ensure the directory exists.
  if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Force -Path $configDir | Out-Null }

  # Backup before modifying (mirrors Merge-Marketplace pattern).
  if (Test-Path $ConfigPath) {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$ConfigPath.bak.plugins.$ts"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
  }

  # Read existing YAML or start from empty string.
  $content = if (Test-Path $ConfigPath) { Get-Content -Raw -LiteralPath $ConfigPath } else { "" }
  if ($null -eq $content) { $content = "" }

  # Strategy: try python3 first (has real YAML support); fall back to sentinel-anchored
  # regex that appends to a plugins.enabled: block or creates one.

  # Sentinel: only run the regex fallback when Python was unavailable or failed.
  $pythonAllSucceeded = $false

  $python = Get-Command python3 -ErrorAction SilentlyContinue
  if ($python) {
    $pyScript = @"
import sys, re
path = sys.argv[1]
name = sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
except FileNotFoundError:
    text = ''

# Find or create plugins.enabled block.
block_re = re.compile(r'(?m)^(plugins\s*:\s*\n(?:[ \t]+\S[^\n]*\n)*[ \t]+enabled\s*:\s*\[)([^\]]*)\]')
inline_re = re.compile(r'(?m)^([ \t]+enabled\s*:\s*\[)([^\]]*)\]')
plugins_section_re = re.compile(r'(?m)^plugins\s*:', re.MULTILINE)

def ensure_name(lst_str, name):
    items = [x.strip().strip('"').strip("'") for x in lst_str.split(',') if x.strip()]
    if name in items:
        return lst_str
    items.append(name)
    return ', '.join(repr(i) for i in items)

m = block_re.search(text)
if m:
    new_list = ensure_name(m.group(2), name)
    text = text[:m.start(2)] + new_list + text[m.end(2):]
else:
    m2 = inline_re.search(text)
    if m2:
        new_list = ensure_name(m2.group(2), name)
        text = text[:m2.start(2)] + new_list + text[m2.end(2):]
    elif plugins_section_re.search(text):
        # plugins: exists but no enabled key -- append it.
        text = plugins_section_re.sub(lambda mo: mo.group(0) + '\n  enabled: [' + repr(name) + ']', text, count=1)
    else:
        # No plugins section at all.
        if text and not text.endswith('\n'):
            text += '\n'
        text += 'plugins:\n  enabled: [' + repr(name) + ']\n'

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)
sys.exit(0)
"@
    $tmp = [System.IO.Path]::GetTempFileName() + ".py"
    [System.IO.File]::WriteAllText($tmp, $pyScript)
    try {
      & python3 $tmp $ConfigPath $pluginName
      $pythonAllSucceeded = ($LASTEXITCODE -eq 0)
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
    if ($pythonAllSucceeded) { return $true }
  }

  # Fallback: pure PowerShell sentinel-anchored regex approach.
  # Only runs when Python was unavailable or exited non-zero.
  # If the file has a plugins.enabled: [...] line, splice in the name.
  # Otherwise append a plugins.enabled block.
  $enabledRe = [regex]'(?m)^([ \t]+enabled\s*:\s*\[)([^\]]*)\]'
  $pluginsSectionRe = [regex]'(?m)^plugins\s*:'

  $m = $enabledRe.Match($content)
  if ($m.Success) {
    $lst = $m.Groups[2].Value
    $items = $lst -split ',' | ForEach-Object { $_.Trim().Trim('"').Trim("'") } | Where-Object { $_ -ne '' }
    if ($pluginName -notin $items) {
      $items += $pluginName
      $newLst = ($items | ForEach-Object { '"' + $_ + '"' }) -join ', '
      $content = $content.Substring(0, $m.Groups[2].Index) + $newLst + $content.Substring($m.Groups[2].Index + $m.Groups[2].Length)
    }
  } elseif ($pluginsSectionRe.IsMatch($content)) {
    $content = $pluginsSectionRe.Replace($content, "plugins:`n  enabled: [""$pluginName""]", 1)
  } else {
    if ($content -and -not $content.EndsWith("`n")) { $content += "`n" }
    $content += "plugins:`n  enabled: [""$pluginName""]`n"
  }

  $tmp2 = "$ConfigPath.tmp"
  [System.IO.File]::WriteAllText($tmp2, $content, [System.Text.Encoding]::UTF8)
  Move-Item -Force -LiteralPath $tmp2 -Destination $ConfigPath
  return $true
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
      # -Depth is PS 6+; PS 5.1 ignores it safely via splatting.
      $cfjArgs = @{ InputObject = $cleaned; ErrorAction = 'Stop' }
      if ($PSVersionTable.PSVersion.Major -ge 6) { $cfjArgs['Depth'] = 32 }
      $parsed = ConvertFrom-Json @cfjArgs
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

# Sweep stale POSIX bash launchers from ~/.local/bin/ before any other
# install logic. Without this, leftover #!/usr/bin/env bash files from a
# pre-1.2.7 install (or one run from WSL) shadow npm's ijfw.cmd shim and
# Windows opens them in Notepad. (Bug report: John H.)
Remove-StalePosixLaunchers

# scripts/install.sh owns the summary (Live now / Standing by / next step).
# Keep clone/pull output suppressed so the final banner reads clean.
Invoke-CloneOrPull $target $Branch | Out-Null

Invoke-InstallScript $target

# Provision Wayland plugin (~/.wayland/plugins/ijfw/).
$waylandPluginDst = Join-Path $env:USERPROFILE ".wayland\plugins\ijfw"
Provision-Plugin -Src "wayland\plugins\ijfw" -Dst $waylandPluginDst -IjfwHome $target

# Provision Hermes plugin (~/.hermes/plugins/ijfw/).
$hermesPluginDst = Join-Path $env:USERPROFILE ".hermes\plugins\ijfw"
Provision-Plugin -Src "hermes\plugins\ijfw" -Dst $hermesPluginDst -IjfwHome $target

# Deploy shared patterns.json (~/.ijfw/shared/lib/patterns.json).
$patternsDir = Join-Path $env:USERPROFILE ".ijfw\shared\lib"
$patternsSrc = Join-Path $target "shared\lib\patterns.json"
if (Test-Path $patternsSrc) {
  New-Item -ItemType Directory -Force -Path $patternsDir | Out-Null
  Copy-Item -Force -LiteralPath $patternsSrc -Destination (Join-Path $patternsDir "patterns.json")
}

# Add "ijfw" to plugins.enabled[] in ~/.hermes/config.yaml (Hermes opt-in allow-list).
$hermesConfig = Join-Path $env:USERPROFILE ".hermes\config.yaml"
[void](Merge-PluginsEnabled -ConfigPath $hermesConfig)

# Regenerate per-platform rules from shared source.
if (Get-Command node -ErrorAction SilentlyContinue) {
  $rulesGen = Join-Path $target "scripts\generate-platform-rules.js"
  if (Test-Path $rulesGen) { & node $rulesGen }
}

if (-not $NoMarketplace) {
  # Best-effort: returns $true on success, prints its own message on fallback.
  # Pass the resolved install root so the marketplace path matches reality
  # for both default and --dir installs.
  [void](Merge-Marketplace -IjfwHome $target)
}

$log = Join-Path $env:USERPROFILE ".ijfw\install.log"
Write-Host "  Full log   $log" -ForegroundColor DarkGray
Write-Host ""
