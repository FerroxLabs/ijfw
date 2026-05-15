import test from 'node:test';
import assert from 'node:assert/strict';

import { fallbackAnalyzePowerShellText } from '../installer/src/preflight/gates/psscriptanalyzer.js';

test('PowerShell fallback ignores comments and accepts balanced installer script', () => {
  const issues = fallbackAnalyzePowerShellText(`
# Invoke-Expression in comments is documentation, not executable code.
function Test-Thing($x) {
  if ($x) { Write-Host "ok" }
}
`, 'ok.ps1');
  assert.deepEqual(issues, []);
});

test('PowerShell fallback flags dynamic execution outside comments', () => {
  const issues = fallbackAnalyzePowerShellText(`
$payload = "Write-Host hi"
Invoke-Expression $payload
`, 'bad.ps1');
  assert.match(issues.join('\n'), /Invoke-Expression/);
});

test('PowerShell fallback flags unbalanced brackets', () => {
  const issues = fallbackAnalyzePowerShellText('function Bad { if ($true) { Write-Host "x" }', 'bad.ps1');
  assert.match(issues.join('\n'), /unclosed bracket/);
});
