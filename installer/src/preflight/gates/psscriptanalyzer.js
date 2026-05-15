// Gate 3: PSScriptAnalyzer -- PowerShell linter.
// When pwsh/PSScriptAnalyzer is unavailable, run a deterministic static
// fallback so local preflight never leaves PowerShell completely unchecked.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findPs1Files(dir, acc = []) {
  let entries;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is repoRoot or a child discovered from repoRoot during the bounded .ps1 scan.
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const full = join(dir, e);
    let st;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- full is a repoRoot child discovered during the bounded .ps1 scan.
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findPs1Files(full, acc);
    else if (e.endsWith('.ps1')) acc.push(full);
  }
  return acc;
}

function stripPowerShellComments(source) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBlockComment = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inBlockComment) {
      if (ch === '#' && next === '>') {
        inBlockComment = false;
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '<' && next === '#') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (!inSingle && !inDouble && ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"' && source[i - 1] !== '`') inDouble = !inDouble;
    i += 1;
  }
  return out;
}

function bracketIssues(source, file) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set(Object.values(pairs));
  const stack = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"' && source[i - 1] !== '`') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (pairs[ch]) stack.push({ ch, index: i });
    else if (closers.has(ch)) {
      const open = stack.pop();
      if (!open || pairs[open.ch] !== ch) return [`${file}: unbalanced bracket near offset ${i}`];
    }
  }
  if (inSingle || inDouble) return [`${file}: unterminated string literal`];
  if (stack.length > 0) return [`${file}: unclosed bracket near offset ${stack[stack.length - 1].index}`];
  return [];
}

export function fallbackAnalyzePowerShellText(source, file = '<inline>') {
  const stripped = stripPowerShellComments(source);
  const issues = bracketIssues(stripped, file);
  const banned = [
    [/\bInvoke-Expression\b|\biex\b/i, 'Invoke-Expression/iex dynamic execution'],
    [/\bSet-ExecutionPolicy\b[\s\S]{0,80}\bBypass\b/i, 'Set-ExecutionPolicy Bypass'],
    [/\bStart-Process\b[\s\S]{0,160}\b-Verb\s+RunAs\b/i, 'Start-Process -Verb RunAs elevation'],
    [/\bNew-Object\s+Net\.WebClient\b|\bDownloadString\s*\(/i, 'legacy WebClient/DownloadString network execution'],
  ];
  for (const [re, label] of banned) {
    if (re.test(stripped)) issues.push(`${file}: banned PowerShell pattern: ${label}`);
  }
  return issues;
}

function runFallback(files, t0, reason) {
  const issues = [];
  for (const file of files) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is a .ps1 path discovered under repoRoot by findPs1Files().
      issues.push(...fallbackAnalyzePowerShellText(readFileSync(file, 'utf8'), file));
    } catch (e) {
      issues.push(`${file}: could not read script (${e.message || e})`);
    }
  }
  if (issues.length > 0) {
    return {
      name: 'psscriptanalyzer',
      status: 'FAIL',
      message: `PowerShell fallback found issues in ${files.length} script(s)`,
      details: [reason, ...issues].slice(0, 20),
      durationMs: Date.now() - t0,
    };
  }
  return {
    name: 'psscriptanalyzer',
    status: 'PASS',
    message: `${files.length} PowerShell script(s) clean (static fallback; ${reason})`,
    details: [],
    durationMs: Date.now() - t0,
  };
}

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();

  const files = findPs1Files(ctx.repoRoot);
  if (files.length === 0) {
    return {
      name: 'psscriptanalyzer',
      status: 'PASS',
      message: 'No PowerShell scripts found',
      details: [],
      durationMs: Date.now() - t0,
    };
  }

  // Check if pwsh is available
  const which = spawnSync('pwsh', ['--version'], { encoding: 'utf8' });
  if (which.status === null || which.error) {
    return runFallback(files, t0, 'pwsh unavailable');
  }

  const moduleCheck = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { exit 0 } else { exit 3 }'],
    { encoding: 'utf8', cwd: ctx.repoRoot, timeout: 10_000 },
  );
  if (moduleCheck.status !== 0) {
    return runFallback(files, t0, 'PSScriptAnalyzer module unavailable');
  }

  // Run PSScriptAnalyzer inline via pwsh
  const script = `
$files = @(${files.map(f => `'${f.replace(/'/g, "''")}'`).join(',')})
$found = $false
foreach ($f in $files) {
  $results = Invoke-ScriptAnalyzer -Path $f -Severity Warning -ErrorAction SilentlyContinue
  if ($results) {
    $found = $true
    foreach ($r in $results) {
      Write-Output "$($r.ScriptName):$($r.Line): [$($r.Severity)] $($r.RuleName) -- $($r.Message)"
    }
  }
}
if ($found) { exit 1 } else { exit 0 }
`;

  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    cwd: ctx.repoRoot,
    timeout: 30_000,
  });

  const durationMs = Date.now() - t0;

  if (res.status === 0) {
    return {
      name: 'psscriptanalyzer',
      status: 'PASS',
      message: `${files.length} PowerShell script(s) clean`,
      details: [],
      durationMs,
    };
  }

  const lines = ((res.stdout || '') + (res.stderr || '')).split('\n').filter(Boolean);
  return {
    name: 'psscriptanalyzer',
    status: 'FAIL',
    message: `PSScriptAnalyzer found issues in ${files.length} script(s)`,
    details: lines.slice(0, 20),
    durationMs,
  };
}

export const name = 'psscriptanalyzer';
export const severity = 'blocking';
export const parallel = true;
