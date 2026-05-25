// transcript.js -- speaker-turn chunking.
//
// Detects turns whose first line starts with `Name:` or `[Name]`. Each turn
// is one chunk. Sequential lines without a speaker prefix belong to the
// current speaker's turn.

import { readFileSync } from 'node:fs';

// Speaker prefix at line start: "Name:" (alphanumeric + spaces) or "[Name]".
// Allow up to 60 chars of name to avoid pathological matches on prose.
const SPEAKER_RE = /^(\[[^\]]{1,60}\]|[A-Za-z][A-Za-z0-9 _.'-]{0,59}:)\s/;

export function splitOnSpeakerTurns(text) {
  const lines = text.split('\n');
  const turns = [];
  let current = null;
  for (const line of lines) {
    if (SPEAKER_RE.test(line)) {
      if (current !== null) turns.push(current);
      current = line;
    } else {
      if (current === null) {
        // pre-amble before any speaker — collect into its own chunk
        current = line;
      } else {
        current += '\n' + line;
      }
    }
  }
  if (current !== null) turns.push(current);
  // trim trailing newlines per turn, drop empty
  return turns.map((t) => t.replace(/\n+$/, '')).filter((t) => t.trim().length > 0);
}

export function extractTranscript(filePath) {
  const text = readFileSync(filePath, 'utf8');
  return { text, chunks: splitOnSpeakerTurns(text) };
}
