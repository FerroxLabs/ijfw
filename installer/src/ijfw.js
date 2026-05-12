// ijfw -- single entry point with subcommand dispatch.
// Subcommands: install, uninstall, preflight, dashboard (v1.1D), doctor, design, help

import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir derives from __dirname via bounded (max 6) parent traversal; not user-controllable.
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

function printHelp() {
  console.log(`
ijfw -- the AI efficiency layer

USAGE
  ijfw <command> [options]

COMMANDS
  install     Install IJFW into your AI coding agents
  uninstall   Remove IJFW from your AI coding agents
  help        Open the full IJFW guide (terminal, or --browser for rendered)
  preflight   Run 11-gate quality pipeline before publishing
  dashboard   Start / stop / check the local observability dashboard
  design      Manage the visual design companion
  doctor      Diagnose IJFW installation health

  --help, -h  Show this help
  --version   Show version
`);
}

function doctorCheck(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split('\n')[0].trim();
  if (r.status === 127 || (r.error && r.error.code === 'ENOENT')) return 'not found';
  return `exit ${r.status} (may be transient)`;
}

// Locate cross-orchestrator-cli.js from one of:
//   1. repoRoot() (running from a clone)
//   2. ~/.ijfw/mcp-server/src/ (post-install)
// Returns the absolute path if found, else null.
function findCli() {
  const candidates = [
    join(repoRoot(), 'mcp-server', 'src', 'cross-orchestrator-cli.js'),
    join(homedir(), '.ijfw', 'mcp-server', 'src', 'cross-orchestrator-cli.js'),
  ];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidates is a static 2-element list of internal install paths; not user-controllable.
  return candidates.find(p => existsSync(p)) || null;
}

// Delegate the full argv tail to cross-orchestrator-cli.js.
// Returns true when delegation happened (so caller skips fallback).
// Exits with the delegated process's status on success.
function delegateToCli(argTail) {
  const cli = findCli();
  if (!cli) return false;
  const r = spawnSync(process.execPath, [cli, ...argTail], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

async function main() {
  const argv = process.argv;
  const sub = argv[2];

  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    process.exit(0);
  }

  if (sub === '--version' || sub === '-v' || sub === 'version') {
    // 1.1.6: full version surface lives in cross-orchestrator-cli.js (terminal CLI).
    // Delegate when the repo + cli are reachable; fall back to bare version on naked npx.
    const verbose = argv.slice(3).includes('--verbose');
    if (delegateToCli(argv.slice(2))) return;
    try {
      const pkgPath = join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      console.log(`@ijfw/install@${pkg.version || 'unknown'}`);
      if (verbose) {
        console.log('  (full --verbose details require a completed install: run ijfw install)');
      }
    } catch {
      console.log('unknown');
    }
    process.exit(0);
  }

  // 1.1.6: terminal-side commands -- delegate to cross-orchestrator-cli.js
  // when the repo is present (post-install). For naked npx invocations
  // (no repo), print a helpful pointer instead of exploding.
  if (sub === 'update' || sub === 'statusline' || sub === 'config' || sub === 'insight') {
    if (delegateToCli(argv.slice(2))) return;
    console.error(`'ijfw ${sub}' requires a completed IJFW install. Run: ijfw install`);
    process.exit(1);
  }

  switch (sub) {
    case 'install': {
      // Delegate to dist/install.js via the existing entry point
      const installBin = resolve(__dirname, '..', 'dist', 'install.js');
      const r = spawnSync('node', [installBin, ...argv.slice(3)], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
      break;
    }
    case 'uninstall': {
      const uninstallBin = resolve(__dirname, '..', 'dist', 'uninstall.js');
      const r = spawnSync('node', [uninstallBin, ...argv.slice(3)], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
      break;
    }
    case 'preflight': {
      const { runPreflightCommand } = await import('./preflight.js');
      await runPreflightCommand([argv[0], argv[1], ...argv.slice(3)], repoRoot());
      break;
    }
    case 'dashboard': {
      const dashSub = argv[3]; // start | stop | status | render
      const root = repoRoot();
      const ijfwHome = join(homedir(), '.ijfw');

      // Resolve an internal asset against (repo clone) -> (~/.ijfw post-install).
      // npm installs ship only the CLI shim; the dashboard bins live under
      // ~/.ijfw/mcp-server/ once `ijfw-install` has run, so we must check both.
      const findInTree = (...rel) => {
        const candidates = [join(root, ...rel), join(ijfwHome, ...rel)];
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidates is a static 2-element list of internal install paths.
        return candidates.find(p => existsSync(p)) || null;
      };

      if (dashSub === 'start' || dashSub === 'stop' || dashSub === 'status') {
        // V1.1D: HTTP server subcommands via ijfw-dashboard bin
        const dashBin = findInTree('mcp-server', 'bin', 'ijfw-dashboard');
        if (dashBin) {
          const r = spawnSync('node', [dashBin, dashSub, ...argv.slice(4)], { stdio: 'inherit' });
          process.exit(r.status ?? 0);
        } else {
          // Fallback: run dashboard-server.js directly for start
          const serverJs = findInTree('mcp-server', 'src', 'dashboard-server.js');
          if (dashSub === 'start' && serverJs) {
            const { spawn } = await import('node:child_process');
            const child = spawn(process.execPath, [serverJs, 'start', '--daemon'], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
            console.log('Dashboard starting... (check: ijfw dashboard status)');
            process.exit(0);
          }
          console.log('[ijfw] Dashboard not found. Try `ijfw-install` to deploy ~/.ijfw/, or run from the IJFW repo root.');
          process.exit(1);
        }
      } else if (dashSub === 'render' || !dashSub) {
        // V1.1C: render terminal dashboard
        const binJs = findInTree('scripts', 'dashboard', 'bin.js');
        if (binJs) {
          const r = spawnSync('node', [binJs, ...argv.slice(dashSub ? 4 : 3)], { stdio: 'inherit' });
          process.exit(r.status ?? 0);
        } else {
          console.log('[ijfw] Run `ijfw dashboard start` to launch the web dashboard.');
          process.exit(1);
        }
      } else {
        console.log('Usage: ijfw dashboard <start|stop|status|render>');
        process.exit(1);
      }
      break;
    }
    case 'design': {
      const designSub = argv[3];
      const contentDir = join(homedir(), '.ijfw', 'design-companion', 'content');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- contentDir is a constant under $HOME/.ijfw/; not user-controllable.
      mkdirSync(contentDir, { recursive: true });

      if (designSub === 'push') {
        const filePath = argv[4];
        if (!filePath) {
          console.error('Usage: ijfw design push <file.html>');
          process.exit(1);
        }
        const abs = resolve(filePath);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is the user's own argv[4]; existsSync just checks readability, copy destination uses basename(abs) so writes are confined to contentDir.
        if (!existsSync(abs)) {
          console.error(`File not found: ${abs}`);
          process.exit(1);
        }
        const dest = join(contentDir, basename(abs));
        copyFileSync(abs, dest);
        console.log(`Design pushed: ${dest}`);
      } else if (designSub === 'clear') {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- contentDir is the same internal constant from line 168; not user-controllable.
        const files = readdirSync(contentDir);
        for (const f of files) rmSync(join(contentDir, f), { force: true });
        console.log('Design companion content cleared.');
      } else {
        console.log('ijfw design -- Manage the visual design companion. Push HTML mockups for live preview.');
        console.log('');
        console.log('Usage: ijfw design push <file.html> | ijfw design clear');
        process.exit(1);
      }
      break;
    }
    case 'help': {
      const wantsBrowser = argv.slice(3).includes('--browser');
      const candidates = [
        join(repoRoot(), 'docs', 'GUIDE.md'),
        resolve(__dirname, '..', 'docs', 'GUIDE.md'),
        join(homedir(), '.ijfw', 'docs', 'GUIDE.md'),
      ];
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidates is a static 3-element list of internal install paths; not user-controllable.
      const guidePath = candidates.find(p => existsSync(p));
      if (!guidePath) {
        console.error('[ijfw] Guide not found. Run `ijfw install` to fetch the full guide, or visit https://gitlab.com/therealseandonahoe/ijfw/-/blob/main/docs/GUIDE.md');
        process.exit(1);
      }

      if (wantsBrowser) {
        const { marked } = await import('marked');
        const assetsSrc = join(dirname(guidePath), 'guide', 'assets');
        const outDir = join(homedir(), '.ijfw', 'guide');
        mkdirSync(join(outDir, 'assets'), { recursive: true });
        if (existsSync(assetsSrc)) {
          for (const f of readdirSync(assetsSrc)) {
            copyFileSync(join(assetsSrc, f), join(outDir, 'assets', f));
          }
        }
        const md = readFileSync(guidePath, 'utf8').replace(/\(guide\/assets\//g, '(assets/');
        const rendered = marked.parse(md, { gfm: true, breaks: false });
        const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>IJFW Guide</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown-dark.css"/>
<style>
  body{margin:0;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:48px 32px}
  .markdown-body{background:transparent;color:#e6edf3}
  pre,code{font-family:ui-monospace,Menlo,Consolas,monospace}
  img{border-radius:8px;max-width:100%}
  table{display:table;width:100%}
</style>
</head><body><div class="wrap markdown-body">${rendered}</div></body></html>`;
        const outHtml = join(outDir, 'index.html');
        writeFileSync(outHtml, html);
        const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
        spawnSync(opener, [outHtml], { stdio: 'ignore', detached: true });
        console.log(`[ijfw] Guide opened in your browser.`);
        console.log(`       Local copy: ${outHtml}`);
        process.exit(0);
      }

      const hasLess = spawnSync('less', ['-V'], { stdio: 'ignore' }).status === 0;
      if (hasLess) {
        const lessRes = spawnSync('less', ['-R', guidePath], { stdio: 'inherit' });
        if (lessRes.status !== 0 && lessRes.status !== null) {
          process.stdout.write(readFileSync(guidePath, 'utf8'));
        }
      } else {
        process.stdout.write(readFileSync(guidePath, 'utf8'));
      }
      process.exit(0);
      break;
    }
    case 'doctor': {
      console.log('\nijfw doctor\n');
      console.log('  node:       ' + doctorCheck('node', ['--version']));
      console.log('  git:        ' + doctorCheck('git', ['--version']));
      console.log('  shellcheck: ' + doctorCheck('shellcheck', ['--version']));
      console.log('  gitleaks:   ' + doctorCheck('gitleaks', ['version']));
      console.log('');
      process.exit(0);
      break;
    }
    default: {
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
