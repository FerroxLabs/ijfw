#!/usr/bin/env node
// Symbol-graph fixture generator -- D2 grader inputs.
//
// Authors 60+ fixtures (5 kinds x 10 synthetic + 5 kinds x 2 real-repo)
// at test/fixtures/symbol-graph/<kind>/<n>/{input,expected}.json. Real-repo
// fixtures additionally carry README.md documenting source + sanitization.
//
// Usage: node test/fixtures/symbol-graph/_generate.mjs
//
// Idempotent: safe to re-run; overwrites generated files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function writeJSON(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

function entityKey(kind, name) { return `${kind}:${name}`; }

// ---------------------------------------------------------------------------
// FILE FIXTURES (10 synthetic + 2 real)
// Coverage targets: posix paths, windows paths, relative, absolute,
// with/without extensions, deeply nested.
// ---------------------------------------------------------------------------
const fileFixtures = [
  {
    n: 1,
    label: 'posix-relative-simple',
    entries: [
      { id: 1, body: 'added auth flow to src/auth/login.js, uses validateToken from src/lib/jwt.js', kind: 'observation' },
      { id: 2, body: 'fixed bug in src/auth/login.js where validateToken returned wrong type', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'src/auth/login.js' },
      { kind: 'file', name: 'src/lib/jwt.js' },
      { kind: 'function', name: 'validateToken' }
    ],
    edges: [
      { src: 'file:src/auth/login.js', dst: 'function:validateToken', kind: 'co_occurs' },
      { src: 'function:validateToken', dst: 'file:src/lib/jwt.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    label: 'posix-deeply-nested',
    entries: [
      { id: 1, body: 'refactored packages/core/src/internal/runtime/scheduler/queue.ts to use ring buffer', kind: 'observation' },
      { id: 2, body: 'packages/core/src/internal/runtime/scheduler/queue.ts test coverage now at 92%', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'packages/core/src/internal/runtime/scheduler/queue.ts' }
    ],
    edges: []
  },
  {
    n: 3,
    label: 'windows-backslash-path',
    entries: [
      { id: 1, body: 'patched C:\\\\Users\\\\dev\\\\app\\\\src\\\\main.cs after build break', kind: 'observation' },
      { id: 2, body: 'C:\\\\Users\\\\dev\\\\app\\\\src\\\\main.cs now compiles cleanly under net8.0', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'C:\\Users\\dev\\app\\src\\main.cs' }
    ],
    edges: []
  },
  {
    n: 4,
    label: 'absolute-posix-path',
    entries: [
      { id: 1, body: 'updated /etc/nginx/conf.d/api.conf to add upstream block', kind: 'observation' },
      { id: 2, body: 'reloaded nginx after edit to /etc/nginx/conf.d/api.conf', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: '/etc/nginx/conf.d/api.conf' }
    ],
    edges: []
  },
  {
    n: 5,
    label: 'no-extension-file',
    entries: [
      { id: 1, body: 'added Makefile target for release; Makefile updated with publish step', kind: 'observation' },
      { id: 2, body: 'Dockerfile now multi-stage, mirrors Makefile build target', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'Makefile' },
      { kind: 'file', name: 'Dockerfile' }
    ],
    edges: [
      { src: 'file:Makefile', dst: 'file:Dockerfile', kind: 'co_occurs' }
    ]
  },
  {
    n: 6,
    label: 'mixed-extensions',
    entries: [
      { id: 1, body: 'wired up src/api/users.ts, src/api/users.test.ts, and src/api/users.md docs', kind: 'observation' },
      { id: 2, body: 'src/api/users.ts handler now exported, src/api/users.test.ts passing', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'src/api/users.ts' },
      { kind: 'file', name: 'src/api/users.test.ts' },
      { kind: 'file', name: 'src/api/users.md' }
    ],
    edges: [
      { src: 'file:src/api/users.ts', dst: 'file:src/api/users.test.ts', kind: 'co_occurs' },
      { src: 'file:src/api/users.ts', dst: 'file:src/api/users.md', kind: 'co_occurs' }
    ]
  },
  {
    n: 7,
    label: 'dotfile-and-config',
    entries: [
      { id: 1, body: 'tightened .eslintrc.json rules; .prettierrc adjusted to match', kind: 'observation' },
      { id: 2, body: '.github/workflows/ci.yml now runs lint with .eslintrc.json config', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: '.eslintrc.json' },
      { kind: 'file', name: '.prettierrc' },
      { kind: 'file', name: '.github/workflows/ci.yml' }
    ],
    edges: [
      { src: 'file:.eslintrc.json', dst: 'file:.prettierrc', kind: 'co_occurs' },
      { src: 'file:.github/workflows/ci.yml', dst: 'file:.eslintrc.json', kind: 'co_occurs' }
    ]
  },
  {
    n: 8,
    label: 'parens-and-spaces-rare',
    entries: [
      { id: 1, body: 'imported docs/Design Notes/v2-overview.md into the planning bundle', kind: 'observation' },
      { id: 2, body: 'docs/Design Notes/v2-overview.md cross-references docs/api.md', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'docs/Design Notes/v2-overview.md' },
      { kind: 'file', name: 'docs/api.md' }
    ],
    edges: [
      { src: 'file:docs/Design Notes/v2-overview.md', dst: 'file:docs/api.md', kind: 'co_occurs' }
    ]
  },
  {
    n: 9,
    label: 'monorepo-package-paths',
    entries: [
      { id: 1, body: 'apps/web/src/pages/index.tsx now consumes @repo/ui via packages/ui/src/index.ts', kind: 'observation' },
      { id: 2, body: 'packages/ui/src/index.ts barrel updated; apps/web/src/pages/index.tsx imports Button', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'apps/web/src/pages/index.tsx' },
      { kind: 'file', name: 'packages/ui/src/index.ts' }
    ],
    edges: [
      { src: 'file:apps/web/src/pages/index.tsx', dst: 'file:packages/ui/src/index.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 10,
    label: 'multi-language-mix',
    entries: [
      { id: 1, body: 'native bridge: src/bridge.rs talks to src/bridge.ts via JSON over IPC', kind: 'observation' },
      { id: 2, body: 'src/bridge.rs adds new opcode, src/bridge.ts decoder updated to match', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'src/bridge.rs' },
      { kind: 'file', name: 'src/bridge.ts' }
    ],
    edges: [
      { src: 'file:src/bridge.rs', dst: 'file:src/bridge.ts', kind: 'co_occurs' }
    ]
  }
];

const fileRealFixtures = [
  {
    n: 1,
    source: 'torvalds/linux (kernel/sched/core.c, kernel/fork.c)',
    sanitization: 'No secrets present. Author names removed. Paths verbatim from upstream master at commit-ish c1234abc (placeholder).',
    entries: [
      { id: 1, body: 'audit log: kernel/sched/core.c -- scheduler tick path adjusted; calls __schedule from kernel/sched/core.c into kernel/fork.c copy_process', kind: 'observation' },
      { id: 2, body: 'kernel/fork.c copy_process gains new flag plumbed from kernel/sched/core.c; include/linux/sched.h header bumped', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'kernel/sched/core.c' },
      { kind: 'file', name: 'kernel/fork.c' },
      { kind: 'file', name: 'include/linux/sched.h' },
      { kind: 'function', name: '__schedule' },
      { kind: 'function', name: 'copy_process' }
    ],
    edges: [
      { src: 'file:kernel/sched/core.c', dst: 'function:__schedule', kind: 'co_occurs' },
      { src: 'file:kernel/sched/core.c', dst: 'file:kernel/fork.c', kind: 'co_occurs' },
      { src: 'file:kernel/fork.c', dst: 'function:copy_process', kind: 'co_occurs' },
      { src: 'file:kernel/sched/core.c', dst: 'file:include/linux/sched.h', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    source: 'expressjs/express (lib/router/index.js, lib/application.js)',
    sanitization: 'Public repo, MIT-licensed. No PII in observation text. File paths verbatim. Synthesised observation phrasing from commit log style.',
    entries: [
      { id: 1, body: 'lib/router/index.js handle path now defers to lib/application.js for fallback rendering', kind: 'observation' },
      { id: 2, body: 'fixed router cache bust in lib/router/index.js after lib/application.js mount changed', kind: 'observation' }
    ],
    entities: [
      { kind: 'file', name: 'lib/router/index.js' },
      { kind: 'file', name: 'lib/application.js' }
    ],
    edges: [
      { src: 'file:lib/router/index.js', dst: 'file:lib/application.js', kind: 'co_occurs' }
    ]
  }
];

// ---------------------------------------------------------------------------
// FUNCTION FIXTURES
// Coverage: camelCase, snake_case, Class.method, arrow, async,
// generic/templated, getter/setter, lifecycle hook, free function,
// builtin-shadowed.
// ---------------------------------------------------------------------------
const functionFixtures = [
  {
    n: 1,
    label: 'camelCase-function',
    entries: [
      { id: 1, body: 'wrote getUserById in src/users/repo.ts; getUserById hits the cache first', kind: 'observation' },
      { id: 2, body: 'getUserById now memoised; src/users/repo.ts test passes', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'getUserById' },
      { kind: 'file', name: 'src/users/repo.ts' }
    ],
    edges: [
      { src: 'function:getUserById', dst: 'file:src/users/repo.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    label: 'snake_case-function',
    entries: [
      { id: 1, body: 'added compute_hash in lib/crypto.py; compute_hash uses blake2b', kind: 'observation' },
      { id: 2, body: 'lib/crypto.py compute_hash benchmark added', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'compute_hash' },
      { kind: 'file', name: 'lib/crypto.py' }
    ],
    edges: [
      { src: 'function:compute_hash', dst: 'file:lib/crypto.py', kind: 'co_occurs' }
    ]
  },
  {
    n: 3,
    label: 'class-method-dot-notation',
    entries: [
      { id: 1, body: 'UserService.findByEmail in src/services/user.ts now respects soft-delete; UserService.findByEmail returns null on tombstones', kind: 'observation' },
      { id: 2, body: 'UserService.findByEmail benchmark improved; src/services/user.ts tests green', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'UserService.findByEmail' },
      { kind: 'file', name: 'src/services/user.ts' }
    ],
    edges: [
      { src: 'function:UserService.findByEmail', dst: 'file:src/services/user.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 4,
    label: 'arrow-function',
    entries: [
      { id: 1, body: 'introduced arrow handleSubmit in src/components/Form.tsx; handleSubmit binds via useCallback', kind: 'observation' },
      { id: 2, body: 'handleSubmit now logs analytics; src/components/Form.tsx ships in next release', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'handleSubmit' },
      { kind: 'file', name: 'src/components/Form.tsx' }
    ],
    edges: [
      { src: 'function:handleSubmit', dst: 'file:src/components/Form.tsx', kind: 'co_occurs' }
    ]
  },
  {
    n: 5,
    label: 'async-function',
    entries: [
      { id: 1, body: 'async fetchProfile in src/api/profile.ts now retries on 503; fetchProfile uses exponential backoff', kind: 'observation' },
      { id: 2, body: 'fetchProfile timing improved; src/api/profile.ts test stable across 1k runs', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'fetchProfile' },
      { kind: 'file', name: 'src/api/profile.ts' }
    ],
    edges: [
      { src: 'function:fetchProfile', dst: 'file:src/api/profile.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 6,
    label: 'generic-templated-function',
    entries: [
      { id: 1, body: 'mapMaybe<T, U> in src/util/maybe.ts handles undefined; mapMaybe is the new lifting primitive', kind: 'observation' },
      { id: 2, body: 'mapMaybe doc-comment updated in src/util/maybe.ts', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'mapMaybe' },
      { kind: 'file', name: 'src/util/maybe.ts' }
    ],
    edges: [
      { src: 'function:mapMaybe', dst: 'file:src/util/maybe.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 7,
    label: 'lifecycle-hook',
    entries: [
      { id: 1, body: 'componentDidMount in src/Dashboard.jsx now subscribes to socket; componentDidMount cleanup in componentWillUnmount', kind: 'observation' },
      { id: 2, body: 'componentWillUnmount unsubscribes; src/Dashboard.jsx no longer leaks listeners', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'componentDidMount' },
      { kind: 'function', name: 'componentWillUnmount' },
      { kind: 'file', name: 'src/Dashboard.jsx' }
    ],
    edges: [
      { src: 'function:componentDidMount', dst: 'file:src/Dashboard.jsx', kind: 'co_occurs' },
      { src: 'function:componentWillUnmount', dst: 'file:src/Dashboard.jsx', kind: 'co_occurs' },
      { src: 'function:componentDidMount', dst: 'function:componentWillUnmount', kind: 'co_occurs' }
    ]
  },
  {
    n: 8,
    label: 'free-function-cross-file',
    entries: [
      { id: 1, body: 'sanitize in lib/sanitize.go calls escapeHTML; escapeHTML lives in lib/escape.go', kind: 'observation' },
      { id: 2, body: 'sanitize wired into request middleware; escapeHTML test added', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'sanitize' },
      { kind: 'function', name: 'escapeHTML' },
      { kind: 'file', name: 'lib/sanitize.go' },
      { kind: 'file', name: 'lib/escape.go' }
    ],
    edges: [
      { src: 'function:sanitize', dst: 'file:lib/sanitize.go', kind: 'co_occurs' },
      { src: 'function:escapeHTML', dst: 'file:lib/escape.go', kind: 'co_occurs' },
      { src: 'function:sanitize', dst: 'function:escapeHTML', kind: 'co_occurs' }
    ]
  },
  {
    n: 9,
    label: 'getter-setter-pair',
    entries: [
      { id: 1, body: 'Settings.getTheme and Settings.setTheme in src/settings.ts persist via localStorage', kind: 'observation' },
      { id: 2, body: 'Settings.setTheme now emits change event; Settings.getTheme reflects immediately', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'Settings.getTheme' },
      { kind: 'function', name: 'Settings.setTheme' },
      { kind: 'file', name: 'src/settings.ts' }
    ],
    edges: [
      { src: 'function:Settings.getTheme', dst: 'file:src/settings.ts', kind: 'co_occurs' },
      { src: 'function:Settings.setTheme', dst: 'file:src/settings.ts', kind: 'co_occurs' },
      { src: 'function:Settings.getTheme', dst: 'function:Settings.setTheme', kind: 'co_occurs' }
    ]
  },
  {
    n: 10,
    label: 'pythonic-dunder-and-method',
    entries: [
      { id: 1, body: 'Connection.__enter__ in db/conn.py opens cursor; Connection.close releases pool', kind: 'observation' },
      { id: 2, body: 'Connection.close now idempotent; Connection.__enter__ logs trace id', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'Connection.__enter__' },
      { kind: 'function', name: 'Connection.close' },
      { kind: 'file', name: 'db/conn.py' }
    ],
    edges: [
      { src: 'function:Connection.__enter__', dst: 'file:db/conn.py', kind: 'co_occurs' },
      { src: 'function:Connection.close', dst: 'file:db/conn.py', kind: 'co_occurs' }
    ]
  }
];

const functionRealFixtures = [
  {
    n: 1,
    source: 'expressjs/express (Router.prototype.handle, Router.prototype.use)',
    sanitization: 'MIT-licensed. Method names verbatim. Observation phrasing synthesised; no commit-author identifiers carried over.',
    entries: [
      { id: 1, body: 'Router.prototype.handle dispatch path now short-circuits when stack empty; Router.prototype.use mount path unchanged', kind: 'observation' },
      { id: 2, body: 'Router.prototype.use now records mount layer position; Router.prototype.handle reads it on dispatch', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'Router.prototype.handle' },
      { kind: 'function', name: 'Router.prototype.use' }
    ],
    edges: [
      { src: 'function:Router.prototype.handle', dst: 'function:Router.prototype.use', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    source: 'nodejs/node (lib/internal/process/promises.js -- promiseResolve, processPromiseRejections)',
    sanitization: 'Public source. No author/email retained. Function names verbatim from upstream main; observation copy synthesised.',
    entries: [
      { id: 1, body: 'processPromiseRejections now batches across microtasks; promiseResolve fast-path covers settled values', kind: 'observation' },
      { id: 2, body: 'promiseResolve no longer allocates closure per call; processPromiseRejections tail-calls reporter', kind: 'observation' }
    ],
    entities: [
      { kind: 'function', name: 'processPromiseRejections' },
      { kind: 'function', name: 'promiseResolve' }
    ],
    edges: [
      { src: 'function:processPromiseRejections', dst: 'function:promiseResolve', kind: 'co_occurs' }
    ]
  }
];

// ---------------------------------------------------------------------------
// IDENTIFIER FIXTURES
// Coverage: UPPER_SNAKE constants, PascalCase classes, types, enums,
// React hooks, namespace-prefixed, plain camelCase variables that are not
// functions.
// ---------------------------------------------------------------------------
const identifierFixtures = [
  {
    n: 1,
    label: 'upper-snake-constant',
    entries: [
      { id: 1, body: 'bumped MAX_RETRY_COUNT to 5 in src/config/retry.ts; MAX_RETRY_COUNT also referenced in tests', kind: 'observation' },
      { id: 2, body: 'MAX_RETRY_COUNT now configurable via env; src/config/retry.ts reads default of 5', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'MAX_RETRY_COUNT' },
      { kind: 'file', name: 'src/config/retry.ts' }
    ],
    edges: [
      { src: 'identifier:MAX_RETRY_COUNT', dst: 'file:src/config/retry.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    label: 'pascal-class',
    entries: [
      { id: 1, body: 'introduced UserSession class in src/session/UserSession.ts; UserSession persists in IndexedDB', kind: 'observation' },
      { id: 2, body: 'UserSession serialisation tested; src/session/UserSession.ts API stable', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'UserSession' },
      { kind: 'file', name: 'src/session/UserSession.ts' }
    ],
    edges: [
      { src: 'identifier:UserSession', dst: 'file:src/session/UserSession.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 3,
    label: 'typescript-type-alias',
    entries: [
      { id: 1, body: 'added RequestContext type in src/types/context.ts; RequestContext carries tenant + traceId', kind: 'observation' },
      { id: 2, body: 'RequestContext now generic over tenant; src/types/context.ts ships next', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'RequestContext' },
      { kind: 'file', name: 'src/types/context.ts' }
    ],
    edges: [
      { src: 'identifier:RequestContext', dst: 'file:src/types/context.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 4,
    label: 'enum-value',
    entries: [
      { id: 1, body: 'OrderStatus.PENDING and OrderStatus.SHIPPED added to src/orders/types.ts', kind: 'observation' },
      { id: 2, body: 'OrderStatus.SHIPPED now triggers fulfilment hook; OrderStatus.PENDING stays default', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'OrderStatus.PENDING' },
      { kind: 'identifier', name: 'OrderStatus.SHIPPED' },
      { kind: 'file', name: 'src/orders/types.ts' }
    ],
    edges: [
      { src: 'identifier:OrderStatus.PENDING', dst: 'file:src/orders/types.ts', kind: 'co_occurs' },
      { src: 'identifier:OrderStatus.SHIPPED', dst: 'file:src/orders/types.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 5,
    label: 'react-hook-identifier',
    entries: [
      { id: 1, body: 'wrote useDebouncedValue hook in src/hooks/useDebouncedValue.ts; useDebouncedValue returns latest after delay', kind: 'observation' },
      { id: 2, body: 'useDebouncedValue handles unmount cleanup; src/hooks/useDebouncedValue.ts stable', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'useDebouncedValue' },
      { kind: 'file', name: 'src/hooks/useDebouncedValue.ts' }
    ],
    edges: [
      { src: 'identifier:useDebouncedValue', dst: 'file:src/hooks/useDebouncedValue.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 6,
    label: 'namespace-prefixed-symbol',
    entries: [
      { id: 1, body: 'Auth.tokenStore now memory-only by default; Auth.tokenStore swapped via Auth.configure', kind: 'observation' },
      { id: 2, body: 'Auth.configure documented in src/auth/index.ts; Auth.tokenStore export unchanged', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'Auth.tokenStore' },
      { kind: 'identifier', name: 'Auth.configure' },
      { kind: 'file', name: 'src/auth/index.ts' }
    ],
    edges: [
      { src: 'identifier:Auth.tokenStore', dst: 'file:src/auth/index.ts', kind: 'co_occurs' },
      { src: 'identifier:Auth.configure', dst: 'file:src/auth/index.ts', kind: 'co_occurs' },
      { src: 'identifier:Auth.tokenStore', dst: 'identifier:Auth.configure', kind: 'co_occurs' }
    ]
  },
  {
    n: 7,
    label: 'go-exported-type',
    entries: [
      { id: 1, body: 'added Server struct in cmd/server/main.go; Server holds router + listener', kind: 'observation' },
      { id: 2, body: 'Server.Shutdown waits for in-flight requests; cmd/server/main.go ready for prod', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'Server' },
      { kind: 'file', name: 'cmd/server/main.go' }
    ],
    edges: [
      { src: 'identifier:Server', dst: 'file:cmd/server/main.go', kind: 'co_occurs' }
    ]
  },
  {
    n: 8,
    label: 'rust-trait-and-struct',
    entries: [
      { id: 1, body: 'defined Encoder trait in src/codec.rs; Encoder is implemented by JsonEncoder struct', kind: 'observation' },
      { id: 2, body: 'JsonEncoder now derives Default; Encoder trait gains stream variant', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'Encoder' },
      { kind: 'identifier', name: 'JsonEncoder' },
      { kind: 'file', name: 'src/codec.rs' }
    ],
    edges: [
      { src: 'identifier:Encoder', dst: 'file:src/codec.rs', kind: 'co_occurs' },
      { src: 'identifier:JsonEncoder', dst: 'file:src/codec.rs', kind: 'co_occurs' },
      { src: 'identifier:Encoder', dst: 'identifier:JsonEncoder', kind: 'co_occurs' }
    ]
  },
  {
    n: 9,
    label: 'config-flag-constant',
    entries: [
      { id: 1, body: 'flipped FEATURE_NEW_DASHBOARD to true in src/flags.ts; FEATURE_NEW_DASHBOARD gated behind tenant id', kind: 'observation' },
      { id: 2, body: 'FEATURE_NEW_DASHBOARD rollout at 25 percent; src/flags.ts will be flipped fully next week', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'FEATURE_NEW_DASHBOARD' },
      { kind: 'file', name: 'src/flags.ts' }
    ],
    edges: [
      { src: 'identifier:FEATURE_NEW_DASHBOARD', dst: 'file:src/flags.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 10,
    label: 'multi-symbol-cluster',
    entries: [
      { id: 1, body: 'Logger class plus DEFAULT_LOG_LEVEL constant added in src/log/index.ts; LogLevel enum exposed', kind: 'observation' },
      { id: 2, body: 'Logger.error now respects DEFAULT_LOG_LEVEL; LogLevel.DEBUG suppressed in prod build', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'Logger' },
      { kind: 'identifier', name: 'DEFAULT_LOG_LEVEL' },
      { kind: 'identifier', name: 'LogLevel' },
      { kind: 'identifier', name: 'LogLevel.DEBUG' },
      { kind: 'file', name: 'src/log/index.ts' }
    ],
    edges: [
      { src: 'identifier:Logger', dst: 'file:src/log/index.ts', kind: 'co_occurs' },
      { src: 'identifier:DEFAULT_LOG_LEVEL', dst: 'file:src/log/index.ts', kind: 'co_occurs' },
      { src: 'identifier:LogLevel', dst: 'file:src/log/index.ts', kind: 'co_occurs' },
      { src: 'identifier:LogLevel.DEBUG', dst: 'file:src/log/index.ts', kind: 'co_occurs' },
      { src: 'identifier:Logger', dst: 'identifier:DEFAULT_LOG_LEVEL', kind: 'co_occurs' }
    ]
  }
];

const identifierRealFixtures = [
  {
    n: 1,
    source: 'microsoft/TypeScript (lib/lib.es5.d.ts -- ReadonlyArray, Array, IArguments)',
    sanitization: 'Apache 2.0. Identifier names verbatim from public stdlib types. No author metadata retained.',
    entries: [
      { id: 1, body: 'reviewed ReadonlyArray vs Array distinction; ReadonlyArray is structural-subtype of Array view', kind: 'observation' },
      { id: 2, body: 'IArguments shape used by older runtime; Array methods now also reachable from ReadonlyArray', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'ReadonlyArray' },
      { kind: 'identifier', name: 'Array' },
      { kind: 'identifier', name: 'IArguments' }
    ],
    edges: [
      { src: 'identifier:ReadonlyArray', dst: 'identifier:Array', kind: 'co_occurs' },
      { src: 'identifier:IArguments', dst: 'identifier:Array', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    source: 'facebook/react (packages/react/src/ReactHooks.js -- useState, useEffect, useMemo)',
    sanitization: 'MIT-licensed. Hook names verbatim. Synthesised observation copy; no commit author or PR id retained.',
    entries: [
      { id: 1, body: 'verified useState reducer-form parity; useEffect cleanup stable; useMemo dep-array passthrough', kind: 'observation' },
      { id: 2, body: 'useEffect now warns on async functions; useMemo + useState common pairing in tests', kind: 'observation' }
    ],
    entities: [
      { kind: 'identifier', name: 'useState' },
      { kind: 'identifier', name: 'useEffect' },
      { kind: 'identifier', name: 'useMemo' }
    ],
    edges: [
      { src: 'identifier:useState', dst: 'identifier:useEffect', kind: 'co_occurs' },
      { src: 'identifier:useEffect', dst: 'identifier:useMemo', kind: 'co_occurs' },
      { src: 'identifier:useState', dst: 'identifier:useMemo', kind: 'co_occurs' }
    ]
  }
];

// ---------------------------------------------------------------------------
// ERROR_CODE FIXTURES
// Coverage: ERR_XXX, EBUSY/EEXIST style POSIX, HTTP-like (404), custom
// uppercase strings, scoped (PG/SQL/AWS), namespaced with version.
// ---------------------------------------------------------------------------
const errorCodeFixtures = [
  {
    n: 1,
    label: 'node-style-ERR_',
    entries: [
      { id: 1, body: 'caught ERR_INVALID_ARG_TYPE in src/cli.js arg parser; ERR_INVALID_ARG_TYPE now surfaces user-friendly message', kind: 'observation' },
      { id: 2, body: 'wrapped fs read in try/catch for ERR_INVALID_ARG_TYPE; src/cli.js test green', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'ERR_INVALID_ARG_TYPE' },
      { kind: 'file', name: 'src/cli.js' }
    ],
    edges: [
      { src: 'error_code:ERR_INVALID_ARG_TYPE', dst: 'file:src/cli.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    label: 'posix-EBUSY',
    entries: [
      { id: 1, body: 'EBUSY on lockfile during graph write; retry shim added in mcp-server/lib/graph.js for EBUSY', kind: 'observation' },
      { id: 2, body: 'EEXIST also seen on lock; mcp-server/lib/graph.js handles both EBUSY and EEXIST', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'EBUSY' },
      { kind: 'error_code', name: 'EEXIST' },
      { kind: 'file', name: 'mcp-server/lib/graph.js' }
    ],
    edges: [
      { src: 'error_code:EBUSY', dst: 'file:mcp-server/lib/graph.js', kind: 'co_occurs' },
      { src: 'error_code:EEXIST', dst: 'file:mcp-server/lib/graph.js', kind: 'co_occurs' },
      { src: 'error_code:EBUSY', dst: 'error_code:EEXIST', kind: 'co_occurs' }
    ]
  },
  {
    n: 3,
    label: 'http-status-codes',
    entries: [
      { id: 1, body: 'edge route returned 404 for missing tenant in src/api/tenant.ts; mapped to JSON envelope', kind: 'observation' },
      { id: 2, body: 'on 401 the proxy now refreshes token; src/api/tenant.ts no longer leaks 401 upstream', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'HTTP_404' },
      { kind: 'error_code', name: 'HTTP_401' },
      { kind: 'file', name: 'src/api/tenant.ts' }
    ],
    edges: [
      { src: 'error_code:HTTP_404', dst: 'file:src/api/tenant.ts', kind: 'co_occurs' },
      { src: 'error_code:HTTP_401', dst: 'file:src/api/tenant.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 4,
    label: 'custom-uppercase',
    entries: [
      { id: 1, body: 'raised QUOTA_EXCEEDED from src/billing/quota.ts when tenant over plan; QUOTA_EXCEEDED carries upgrade hint', kind: 'observation' },
      { id: 2, body: 'QUOTA_EXCEEDED now returns suggested plan; src/billing/quota.ts test asserts payload', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'QUOTA_EXCEEDED' },
      { kind: 'file', name: 'src/billing/quota.ts' }
    ],
    edges: [
      { src: 'error_code:QUOTA_EXCEEDED', dst: 'file:src/billing/quota.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 5,
    label: 'scoped-PG',
    entries: [
      { id: 1, body: 'PG_23505 unique violation surfaced from db/users.sql; mapped to USER_EMAIL_TAKEN in src/db/users.ts', kind: 'observation' },
      { id: 2, body: 'src/db/users.ts wraps PG_23505 -> USER_EMAIL_TAKEN translation', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'PG_23505' },
      { kind: 'error_code', name: 'USER_EMAIL_TAKEN' },
      { kind: 'file', name: 'src/db/users.ts' }
    ],
    edges: [
      { src: 'error_code:PG_23505', dst: 'file:src/db/users.ts', kind: 'co_occurs' },
      { src: 'error_code:USER_EMAIL_TAKEN', dst: 'file:src/db/users.ts', kind: 'co_occurs' },
      { src: 'error_code:PG_23505', dst: 'error_code:USER_EMAIL_TAKEN', kind: 'co_occurs' }
    ]
  },
  {
    n: 6,
    label: 'aws-style-prefix',
    entries: [
      { id: 1, body: 'caught ThrottlingException from AWS SDK; ThrottlingException retries via backoff in src/aws/client.ts', kind: 'observation' },
      { id: 2, body: 'AccessDeniedException also handled in src/aws/client.ts; surfaced as 403 to caller', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'ThrottlingException' },
      { kind: 'error_code', name: 'AccessDeniedException' },
      { kind: 'file', name: 'src/aws/client.ts' }
    ],
    edges: [
      { src: 'error_code:ThrottlingException', dst: 'file:src/aws/client.ts', kind: 'co_occurs' },
      { src: 'error_code:AccessDeniedException', dst: 'file:src/aws/client.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 7,
    label: 'numeric-sentinel',
    entries: [
      { id: 1, body: 'returned exit code EXIT_42 from scripts/migrate.sh on partial migration; documented in scripts/migrate.sh header', kind: 'observation' },
      { id: 2, body: 'EXIT_42 now triggers rollback; scripts/migrate.sh idempotent on rerun', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'EXIT_42' },
      { kind: 'file', name: 'scripts/migrate.sh' }
    ],
    edges: [
      { src: 'error_code:EXIT_42', dst: 'file:scripts/migrate.sh', kind: 'co_occurs' }
    ]
  },
  {
    n: 8,
    label: 'graph-write-busy',
    entries: [
      { id: 1, body: 'graph write contention surfaced as EBUSY_GRAPH_WRITE in mcp-server/lib/graph.js; retried 3x with jitter', kind: 'observation' },
      { id: 2, body: 'EBUSY_GRAPH_WRITE now exposed in metrics; mcp-server/lib/graph.js logs every retry', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'EBUSY_GRAPH_WRITE' },
      { kind: 'file', name: 'mcp-server/lib/graph.js' }
    ],
    edges: [
      { src: 'error_code:EBUSY_GRAPH_WRITE', dst: 'file:mcp-server/lib/graph.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 9,
    label: 'js-builtin-types',
    entries: [
      { id: 1, body: 'TypeError thrown from src/parse.ts when input not string; RangeError on offset < 0', kind: 'observation' },
      { id: 2, body: 'TypeError now wrapped with cause; RangeError fast-fails before allocation', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'TypeError' },
      { kind: 'error_code', name: 'RangeError' },
      { kind: 'file', name: 'src/parse.ts' }
    ],
    edges: [
      { src: 'error_code:TypeError', dst: 'file:src/parse.ts', kind: 'co_occurs' },
      { src: 'error_code:RangeError', dst: 'file:src/parse.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 10,
    label: 'long-prefixed-versioned',
    entries: [
      { id: 1, body: 'IJFW_E_GRAPH_LOCK_V2 raised by mcp-server/lib/graph-lock.js when collision detected; supersedes IJFW_E_GRAPH_LOCK_V1', kind: 'observation' },
      { id: 2, body: 'IJFW_E_GRAPH_LOCK_V2 carries collision count; mcp-server/lib/graph-lock.js retries on V2 only', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'IJFW_E_GRAPH_LOCK_V2' },
      { kind: 'error_code', name: 'IJFW_E_GRAPH_LOCK_V1' },
      { kind: 'file', name: 'mcp-server/lib/graph-lock.js' }
    ],
    edges: [
      { src: 'error_code:IJFW_E_GRAPH_LOCK_V2', dst: 'file:mcp-server/lib/graph-lock.js', kind: 'co_occurs' },
      { src: 'error_code:IJFW_E_GRAPH_LOCK_V1', dst: 'file:mcp-server/lib/graph-lock.js', kind: 'co_occurs' },
      { src: 'error_code:IJFW_E_GRAPH_LOCK_V2', dst: 'error_code:IJFW_E_GRAPH_LOCK_V1', kind: 'co_occurs' }
    ]
  }
];

const errorCodeRealFixtures = [
  {
    n: 1,
    source: 'nodejs/node (doc/api/errors.md -- ERR_INVALID_ARG_TYPE, ERR_INVALID_URL, ERR_HTTP_HEADERS_SENT)',
    sanitization: 'Public docs. Error names verbatim. Observation copy synthesised; no contributor handles retained.',
    entries: [
      { id: 1, body: 'ERR_INVALID_ARG_TYPE bubbled from URL parser; ERR_INVALID_URL now wraps it for caller clarity', kind: 'observation' },
      { id: 2, body: 'ERR_HTTP_HEADERS_SENT defended against in middleware; ERR_INVALID_ARG_TYPE separated from validation path', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'ERR_INVALID_ARG_TYPE' },
      { kind: 'error_code', name: 'ERR_INVALID_URL' },
      { kind: 'error_code', name: 'ERR_HTTP_HEADERS_SENT' }
    ],
    edges: [
      { src: 'error_code:ERR_INVALID_ARG_TYPE', dst: 'error_code:ERR_INVALID_URL', kind: 'co_occurs' },
      { src: 'error_code:ERR_HTTP_HEADERS_SENT', dst: 'error_code:ERR_INVALID_ARG_TYPE', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    source: 'POSIX errno.h (EBUSY, ENOENT, EACCES) via man-pages',
    sanitization: 'Public POSIX documentation. No PII present. Codes verbatim.',
    entries: [
      { id: 1, body: 'EBUSY on rmdir; ENOENT on stat after concurrent unlink; EACCES on read of root-owned file', kind: 'observation' },
      { id: 2, body: 'wrapped POSIX errno mapping in lib/fs-errors.c; EBUSY + ENOENT now share retry path, EACCES does not', kind: 'observation' }
    ],
    entities: [
      { kind: 'error_code', name: 'EBUSY' },
      { kind: 'error_code', name: 'ENOENT' },
      { kind: 'error_code', name: 'EACCES' },
      { kind: 'file', name: 'lib/fs-errors.c' }
    ],
    edges: [
      { src: 'error_code:EBUSY', dst: 'error_code:ENOENT', kind: 'co_occurs' },
      { src: 'error_code:EBUSY', dst: 'file:lib/fs-errors.c', kind: 'co_occurs' },
      { src: 'error_code:ENOENT', dst: 'file:lib/fs-errors.c', kind: 'co_occurs' },
      { src: 'error_code:EACCES', dst: 'file:lib/fs-errors.c', kind: 'co_occurs' }
    ]
  }
];

// ---------------------------------------------------------------------------
// DECISION FIXTURES
// Coverage: ADR-style d-<topic>-<date>, commit-message-embedded #decision:,
// planning-doc-embedded, ADR-NNN-style, dated-only, longform topic.
// ---------------------------------------------------------------------------
const decisionFixtures = [
  {
    n: 1,
    label: 'd-topic-date-style',
    entries: [
      { id: 1, body: 'recorded d-auth-rotation-2026-04 in decisions/d-auth-rotation-2026-04.md; rotates JWT secret monthly', kind: 'observation' },
      { id: 2, body: 'src/auth/rotate.ts implements d-auth-rotation-2026-04; cron wired up', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-auth-rotation-2026-04' },
      { kind: 'file', name: 'decisions/d-auth-rotation-2026-04.md' },
      { kind: 'file', name: 'src/auth/rotate.ts' }
    ],
    edges: [
      { src: 'decision:d-auth-rotation-2026-04', dst: 'file:decisions/d-auth-rotation-2026-04.md', kind: 'co_occurs' },
      { src: 'decision:d-auth-rotation-2026-04', dst: 'file:src/auth/rotate.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    label: 'commit-message-decision-tag',
    entries: [
      { id: 1, body: 'commit log carried #decision:retire-legacy-cache: stop using src/cache/legacy.js, replaced by src/cache/lru.ts', kind: 'observation' },
      { id: 2, body: 'src/cache/legacy.js removed in follow-up; #decision:retire-legacy-cache referenced in PR description', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'retire-legacy-cache' },
      { kind: 'file', name: 'src/cache/legacy.js' },
      { kind: 'file', name: 'src/cache/lru.ts' }
    ],
    edges: [
      { src: 'decision:retire-legacy-cache', dst: 'file:src/cache/legacy.js', kind: 'co_occurs' },
      { src: 'decision:retire-legacy-cache', dst: 'file:src/cache/lru.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 3,
    label: 'planning-doc-decision',
    entries: [
      { id: 1, body: '.planning/1.3.0/PRD.md locks d-pillar-spec-required-pre-beta: D-PILLAR-SPEC.md gates Beta release', kind: 'observation' },
      { id: 2, body: 'd-pillar-spec-required-pre-beta tracked in .planning/1.3.0/HANDOFF.md until D-PILLAR-SPEC ships', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-pillar-spec-required-pre-beta' },
      { kind: 'file', name: '.planning/1.3.0/PRD.md' },
      { kind: 'file', name: '.planning/1.3.0/HANDOFF.md' }
    ],
    edges: [
      { src: 'decision:d-pillar-spec-required-pre-beta', dst: 'file:.planning/1.3.0/PRD.md', kind: 'co_occurs' },
      { src: 'decision:d-pillar-spec-required-pre-beta', dst: 'file:.planning/1.3.0/HANDOFF.md', kind: 'co_occurs' }
    ]
  },
  {
    n: 4,
    label: 'adr-numbered',
    entries: [
      { id: 1, body: 'ADR-0007 chose SQLite over Postgres for local memory; documented in docs/adr/ADR-0007.md', kind: 'observation' },
      { id: 2, body: 'mcp-server/lib/store.js implements ADR-0007; pragma settings tuned for write throughput', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'ADR-0007' },
      { kind: 'file', name: 'docs/adr/ADR-0007.md' },
      { kind: 'file', name: 'mcp-server/lib/store.js' }
    ],
    edges: [
      { src: 'decision:ADR-0007', dst: 'file:docs/adr/ADR-0007.md', kind: 'co_occurs' },
      { src: 'decision:ADR-0007', dst: 'file:mcp-server/lib/store.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 5,
    label: 'multiple-decisions-cross-ref',
    entries: [
      { id: 1, body: 'd-redactor-ordering and d-edge-weight-formula both land in D-PILLAR-SPEC.md; d-redactor-ordering precedes secret scrub', kind: 'observation' },
      { id: 2, body: 'd-edge-weight-formula calibration noted; d-redactor-ordering test coverage tracked separately', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-redactor-ordering' },
      { kind: 'decision', name: 'd-edge-weight-formula' },
      { kind: 'file', name: 'D-PILLAR-SPEC.md' }
    ],
    edges: [
      { src: 'decision:d-redactor-ordering', dst: 'file:D-PILLAR-SPEC.md', kind: 'co_occurs' },
      { src: 'decision:d-edge-weight-formula', dst: 'file:D-PILLAR-SPEC.md', kind: 'co_occurs' },
      { src: 'decision:d-redactor-ordering', dst: 'decision:d-edge-weight-formula', kind: 'co_occurs' }
    ]
  },
  {
    n: 6,
    label: 'decision-supersedes-prior',
    entries: [
      { id: 1, body: 'd-eviction-importance-2026-05 supersedes d-eviction-lru-2026-02 in decisions/d-eviction-importance-2026-05.md', kind: 'observation' },
      { id: 2, body: 'd-eviction-importance-2026-05 wired into mcp-server/lib/evict.js; d-eviction-lru-2026-02 marked superseded', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-eviction-importance-2026-05' },
      { kind: 'decision', name: 'd-eviction-lru-2026-02' },
      { kind: 'file', name: 'decisions/d-eviction-importance-2026-05.md' },
      { kind: 'file', name: 'mcp-server/lib/evict.js' }
    ],
    edges: [
      { src: 'decision:d-eviction-importance-2026-05', dst: 'file:decisions/d-eviction-importance-2026-05.md', kind: 'co_occurs' },
      { src: 'decision:d-eviction-importance-2026-05', dst: 'file:mcp-server/lib/evict.js', kind: 'co_occurs' },
      { src: 'decision:d-eviction-importance-2026-05', dst: 'decision:d-eviction-lru-2026-02', kind: 'co_occurs' }
    ]
  },
  {
    n: 7,
    label: 'decision-with-error-code',
    entries: [
      { id: 1, body: 'd-graph-lock-collision chose retry-with-jitter; surfaces EBUSY_GRAPH_WRITE before giving up', kind: 'observation' },
      { id: 2, body: 'mcp-server/lib/graph-lock.js implements d-graph-lock-collision; EBUSY_GRAPH_WRITE retried 3x', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-graph-lock-collision' },
      { kind: 'error_code', name: 'EBUSY_GRAPH_WRITE' },
      { kind: 'file', name: 'mcp-server/lib/graph-lock.js' }
    ],
    edges: [
      { src: 'decision:d-graph-lock-collision', dst: 'error_code:EBUSY_GRAPH_WRITE', kind: 'co_occurs' },
      { src: 'decision:d-graph-lock-collision', dst: 'file:mcp-server/lib/graph-lock.js', kind: 'co_occurs' },
      { src: 'error_code:EBUSY_GRAPH_WRITE', dst: 'file:mcp-server/lib/graph-lock.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 8,
    label: 'short-decision-id',
    entries: [
      { id: 1, body: 'D42 captured in decisions/D42.md: switch to BLAKE3 for content addressing', kind: 'observation' },
      { id: 2, body: 'D42 implemented in src/hash/index.ts; legacy SHA1 path retired', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'D42' },
      { kind: 'file', name: 'decisions/D42.md' },
      { kind: 'file', name: 'src/hash/index.ts' }
    ],
    edges: [
      { src: 'decision:D42', dst: 'file:decisions/D42.md', kind: 'co_occurs' },
      { src: 'decision:D42', dst: 'file:src/hash/index.ts', kind: 'co_occurs' }
    ]
  },
  {
    n: 9,
    label: 'longform-topic-decision',
    entries: [
      { id: 1, body: 'd-prefer-fts5-over-vectors-for-warm-tier captured today; defers vector search to cold tier', kind: 'observation' },
      { id: 2, body: 'mcp-server/lib/search.js follows d-prefer-fts5-over-vectors-for-warm-tier; vectors gated behind opt-in flag', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-prefer-fts5-over-vectors-for-warm-tier' },
      { kind: 'file', name: 'mcp-server/lib/search.js' }
    ],
    edges: [
      { src: 'decision:d-prefer-fts5-over-vectors-for-warm-tier', dst: 'file:mcp-server/lib/search.js', kind: 'co_occurs' }
    ]
  },
  {
    n: 10,
    label: 'decision-cluster-with-files-and-functions',
    entries: [
      { id: 1, body: 'd-tier-promotion-rules sets working->episodic threshold at 3 hits; promote() in mcp-server/lib/promote.js owns it', kind: 'observation' },
      { id: 2, body: 'promote() now reads d-tier-promotion-rules from config; mcp-server/lib/promote.js test asserts threshold', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-tier-promotion-rules' },
      { kind: 'function', name: 'promote' },
      { kind: 'file', name: 'mcp-server/lib/promote.js' }
    ],
    edges: [
      { src: 'decision:d-tier-promotion-rules', dst: 'function:promote', kind: 'co_occurs' },
      { src: 'decision:d-tier-promotion-rules', dst: 'file:mcp-server/lib/promote.js', kind: 'co_occurs' },
      { src: 'function:promote', dst: 'file:mcp-server/lib/promote.js', kind: 'co_occurs' }
    ]
  }
];

const decisionRealFixtures = [
  {
    n: 1,
    source: 'npryce/adr-tools (doc/adr/0001-record-architecture-decisions.md, 0002-implement-as-shell-scripts.md)',
    sanitization: 'MIT-licensed ADR template repo. ADR titles abbreviated; observation copy synthesised. No contributor names retained.',
    entries: [
      { id: 1, body: 'ADR-0001 record-architecture-decisions established the practice; ADR-0002 implement-as-shell-scripts followed', kind: 'observation' },
      { id: 2, body: 'ADR-0002 implement-as-shell-scripts depends on ADR-0001 record-architecture-decisions context', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'ADR-0001' },
      { kind: 'decision', name: 'ADR-0002' }
    ],
    edges: [
      { src: 'decision:ADR-0001', dst: 'decision:ADR-0002', kind: 'co_occurs' }
    ]
  },
  {
    n: 2,
    source: 'IJFW repo .planning/1.3.0/ADR-alpha-schema-reservations.md (sanitised excerpt)',
    sanitization: 'Local IJFW repo; observations rewritten to remove internal commit hashes and any contributor refs. ADR ids verbatim.',
    entries: [
      { id: 1, body: 'd-alpha-schema-reservations locks reserved field names ahead of GA; documented in ADR-alpha-schema-reservations.md', kind: 'observation' },
      { id: 2, body: 'mcp-server/lib/schema.js validates against d-alpha-schema-reservations; ADR-alpha-schema-reservations.md lists reserved keys', kind: 'observation' }
    ],
    entities: [
      { kind: 'decision', name: 'd-alpha-schema-reservations' },
      { kind: 'file', name: 'ADR-alpha-schema-reservations.md' },
      { kind: 'file', name: 'mcp-server/lib/schema.js' }
    ],
    edges: [
      { src: 'decision:d-alpha-schema-reservations', dst: 'file:ADR-alpha-schema-reservations.md', kind: 'co_occurs' },
      { src: 'decision:d-alpha-schema-reservations', dst: 'file:mcp-server/lib/schema.js', kind: 'co_occurs' }
    ]
  }
];

// ---------------------------------------------------------------------------
// EMITTER
// ---------------------------------------------------------------------------

function writeSyntheticFixture(kind, fix) {
  const dir = join(ROOT, kind, String(fix.n));
  writeJSON(join(dir, 'input.json'), { entries: fix.entries });
  writeJSON(join(dir, 'expected.json'), { entities: fix.entities, edges: fix.edges });
}

function writeRealFixture(kind, fix) {
  const dir = join(ROOT, kind, `real-${fix.n}`);
  writeJSON(join(dir, 'input.json'), { entries: fix.entries });
  writeJSON(join(dir, 'expected.json'), { entities: fix.entities, edges: fix.edges });
  const readme = [
    `# ${kind} real-${fix.n}`,
    '',
    `## Source`,
    fix.source,
    '',
    `## Sanitization`,
    fix.sanitization,
    '',
    `## Notes`,
    'Real-repo distribution sample. Observations are synthesised in the style of upstream commit logs / docs; entity names are verbatim where they are public API surface or filesystem paths.',
    'No PII, no secrets, no proprietary strings retained.'
  ].join('\n') + '\n';
  writeText(join(dir, 'README.md'), readme);
}

const all = [
  { kind: 'file', synth: fileFixtures, real: fileRealFixtures },
  { kind: 'function', synth: functionFixtures, real: functionRealFixtures },
  { kind: 'identifier', synth: identifierFixtures, real: identifierRealFixtures },
  { kind: 'error_code', synth: errorCodeFixtures, real: errorCodeRealFixtures },
  { kind: 'decision', synth: decisionFixtures, real: decisionRealFixtures }
];

let totalSynth = 0;
let totalReal = 0;

for (const bucket of all) {
  for (const fix of bucket.synth) {
    writeSyntheticFixture(bucket.kind, fix);
    totalSynth += 1;
  }
  for (const fix of bucket.real) {
    writeRealFixture(bucket.kind, fix);
    totalReal += 1;
  }
}

console.log(`wrote ${totalSynth} synthetic + ${totalReal} real-repo fixtures across ${all.length} kinds`);
