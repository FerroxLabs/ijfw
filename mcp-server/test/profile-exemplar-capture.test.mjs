// profile-exemplar-capture.test.mjs — V1 voice-exemplar capture.
//
// Asserts: snippet captured + register-tagged; PII scrubbed; machine-output /
// code rejected; control prompts skipped; commit-message path; everything routed
// through the transient store and isolated to tmpdir in test context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  captureMessage,
  captureCommitMessage,
  buildExemplar,
  classifyRegister,
} from '../src/profile/exemplar-capture.js';
import { listExemplars, exemplarStorePath } from '../src/profile/exemplar-store.js';

function withTmpProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-exemplar-cap-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- CAPTURE + REGISTER ---

test('captureMessage stores the user prompt as a prompt-source exemplar', () => {
  withTmpProfileDir(() => {
    const r = captureMessage({ text: 'Refactor the auth middleware to share one validation path.' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
    const list = listExemplars();
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'prompt');
    assert.ok(list[0].id.startsWith('exemplar::'));
  });
});

test('classifyRegister tags terse / casual / formal / doc / commit', () => {
  assert.equal(classifyRegister('fix the typo', 'prompt'), 'terse');
  assert.equal(classifyRegister('anything', 'commit-msg'), 'commit');
  assert.equal(
    classifyRegister(
      'Please update the README so it documents the new flag. The default should remain off, and the example must reflect that.',
      'prompt',
    ),
    'formal',
  );
  assert.equal(
    classifyRegister('# Heading\n\nThis is a documentation paragraph with enough prose to count as a doc block here.', 'prompt'),
    'doc',
  );
  // medium, capitalized, single sentence → casual
  assert.equal(classifyRegister('Can you take a look at this when you get a chance?', 'prompt'), 'casual');
});

test('a captured exemplar carries a valid register from the contract enum', () => {
  withTmpProfileDir(() => {
    captureMessage({ text: 'ship it' });
    const list = listExemplars();
    assert.ok(['terse', 'casual', 'formal', 'commit', 'doc'].includes(list[0].register));
  });
});

// --- PII SCRUB ---

test('PII is scrubbed before persist (email, secret, homedir path)', () => {
  withTmpProfileDir(() => {
    captureMessage({
      text: 'Email me at jane.doe@example.com and the token is api_key=sk-supersecretvalue and check /Users/jane/secret.txt please.',
    });
    const list = listExemplars();
    assert.equal(list.length, 1);
    const t = list[0].text;
    assert.ok(!/jane\.doe@example\.com/.test(t), `email leaked: ${t}`);
    assert.ok(!/sk-supersecretvalue/.test(t), `secret leaked: ${t}`);
    assert.ok(!/\/Users\/jane/.test(t), `homedir username leaked: ${t}`);
    // The surrounding natural-language words survive.
    assert.ok(/check/.test(t) && /please/.test(t));
  });
});

// --- MACHINE OUTPUT / CODE REJECTED ---

test('a fenced code block is NOT captured as voice', () => {
  withTmpProfileDir(() => {
    const r = captureMessage({ text: '```js\nfunction f(){ return 1; }\n```' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(listExemplars().length, 0);
  });
});

test('a stack trace is NOT captured', () => {
  withTmpProfileDir(() => {
    const r = captureMessage({
      text: 'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\n    raise ValueError',
    });
    assert.equal(r.skipped, true);
    assert.equal(listExemplars().length, 0);
  });
});

test('a unified diff is NOT captured', () => {
  withTmpProfileDir(() => {
    const r = captureMessage({
      text: 'diff --git a/x.js b/x.js\n@@ -1,3 +1,3 @@\n-old\n+new',
    });
    assert.equal(r.skipped, true);
    assert.equal(listExemplars().length, 0);
  });
});

test('a symbol-dense code paste is NOT captured', () => {
  withTmpProfileDir(() => {
    const r = captureMessage({ text: 'const x = {a:1, b:()=>{ return c<d && e>f; }};' });
    assert.equal(r.skipped, true);
    assert.equal(listExemplars().length, 0);
  });
});

// --- CONTROL PROMPTS SKIPPED ---

test('slash-command and control prompts are skipped', () => {
  withTmpProfileDir(() => {
    for (const text of ['/help me', '*skip this one', '# a comment', 'ijfw off']) {
      const r = captureMessage({ text });
      assert.equal(r.skipped, true, `should skip: ${text}`);
    }
    assert.equal(listExemplars().length, 0);
  });
});

test('empty / whitespace input is skipped', () => {
  withTmpProfileDir(() => {
    assert.equal(captureMessage({ text: '' }).skipped, true);
    assert.equal(captureMessage({ text: '   \n\t ' }).skipped, true);
    assert.equal(listExemplars().length, 0);
  });
});

// --- BOUND ON A SINGLE SNIPPET ---

test('an over-long snippet is bounded to the text cap', () => {
  withTmpProfileDir(() => {
    const long = 'word '.repeat(400); // ~2000 chars of natural-language words
    captureMessage({ text: long });
    const list = listExemplars();
    assert.equal(list.length, 1);
    assert.ok(list[0].text.length <= 600, `expected ≤600, got ${list[0].text.length}`);
  });
});

// --- DEDUP via capture ---

test('capturing the same text twice keeps one record (dedup by id)', () => {
  withTmpProfileDir(() => {
    captureMessage({ text: 'always run the smoke test before shipping' });
    captureMessage({ text: 'always run the smoke test before shipping' });
    assert.equal(listExemplars().length, 1);
  });
});

// --- COMMIT MESSAGE PATH ---

test('captureCommitMessage stores a commit-register exemplar and strips trailers', () => {
  withTmpProfileDir(() => {
    const msg = [
      'fix(store): guard the backup destination against symlink swap',
      '',
      'A pre-planted .bak symlink could redirect the backup copy. Guard the',
      'destination, not just the source.',
      '',
      'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n');
    const r = captureCommitMessage(msg);
    assert.equal(r.ok, true);
    const list = listExemplars();
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'commit-msg');
    assert.equal(list[0].register, 'commit');
    assert.ok(!/Co-Authored-By/i.test(list[0].text), 'trailer stripped');
    assert.ok(!/Generated with/i.test(list[0].text), 'IJFW boilerplate stripped');
    assert.ok(/guard the backup/i.test(list[0].text), 'real subject retained');
  });
});

test('captureCommitMessage on an empty / boilerplate-only message is skipped', () => {
  withTmpProfileDir(() => {
    assert.equal(captureCommitMessage('').skipped, true);
    assert.equal(
      captureCommitMessage('Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>').skipped,
      true,
    );
    assert.equal(listExemplars().length, 0);
  });
});

// --- ISOLATION + FAIL-SOFT ---

test('capture is isolated to tmpdir in test context (never the real homedir)', () => {
  withTmpProfileDir(() => {
    captureMessage({ text: 'verify isolation of the capture path' });
    assert.ok(!exemplarStorePath().startsWith(join(homedir(), '.ijfw')));
  });
});

test('buildExemplar is pure and returns null for skipped inputs', () => {
  assert.equal(buildExemplar({ text: '' }), null);
  assert.equal(buildExemplar({ text: '```code```' }), null);
  const ex = buildExemplar({ text: 'a normal sentence to capture', ts: '2026-01-01T00:00:00.000Z' });
  assert.ok(ex && ex.id.startsWith('exemplar::'));
  assert.equal(ex.ts, '2026-01-01T00:00:00.000Z');
});

test('captureMessage never throws on a malformed payload', () => {
  withTmpProfileDir(() => {
    assert.doesNotThrow(() => captureMessage({}));
    assert.doesNotThrow(() => captureMessage({ text: null }));
    assert.doesNotThrow(() => captureMessage(undefined));
  });
});
