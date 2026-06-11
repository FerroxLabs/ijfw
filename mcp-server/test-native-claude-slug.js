/**
 * test-native-claude-slug.js -- audit fix: NATIVE_CLAUDE_DIR Windows encoding.
 *
 * Claude Code names its per-project folder under ~/.claude/projects/ by
 * flattening the project path into one dash-separated segment. The old
 * encoding only replaced forward slashes, so Windows paths (backslashes +
 * drive colon) produced a nonexistent nested path and the claude-native
 * memory source was silently empty on Windows. The slug must be a single
 * flat segment with no separators or drive colons on every platform.
 * Mirrors pathToSlug() in src/memory/reader.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeClaudeProjectSlug } from './src/server.js';

test('POSIX path encodes as before (no regression)', () => {
  assert.equal(
    encodeClaudeProjectSlug('/Users/sean/dev/ijfw'),
    '-Users-sean-dev-ijfw',
  );
});

test('Windows path: drive colon stripped, backslashes flattened', () => {
  assert.equal(
    encodeClaudeProjectSlug('C:\\Users\\sean\\dev\\ijfw'),
    '-Users-sean-dev-ijfw',
  );
});

test('lowercase drive letter also stripped', () => {
  assert.equal(
    encodeClaudeProjectSlug('c:\\work\\proj'),
    '-work-proj',
  );
});

test('mixed separators produce a single flat segment', () => {
  const slug = encodeClaudeProjectSlug('D:\\a/b\\c');
  assert.equal(slug, '-a-b-c');
  assert.doesNotMatch(slug, /[\\/:]/, 'slug must contain no separators or colons');
});
