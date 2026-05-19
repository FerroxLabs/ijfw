// v1.5.0 audit-LOW-update-#13: single helper for atomic-write tmp-suffix generation.
//
// Before this module, six call sites hand-rolled essentially the same pattern:
//   `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
// or:
//   `${path}.tmp.${randomBytes(4).toString('hex')}`
// or:
//   `${path}.tmp-${process.pid}-${Date.now()}`
//
// The variations carry no semantic difference -- all three are "unique-enough
// per-process collision-resistant temporary filename" -- but the drift made
// audit + diff review noisy and easy to typo. This helper consolidates the
// pattern and standardises the wide form (pid + 8 random bytes hex) so all
// atomic writes share one collision-resistance budget.
//
// Backwards-compat: existing tmp-files that don't follow this exact pattern
// are STILL cleaned up by their callers via the same `if (existsSync(tmp))
// unlinkSync(tmp)` rollback path -- this helper only changes the naming
// scheme on new writes, not the rollback contract.

import { randomBytes } from 'node:crypto';

/**
 * Build a temporary-file suffix for atomic writes (write-tmp + rename).
 *
 * @param {object} [opts]
 * @param {number} [opts.bytes=8]   Number of random bytes in the suffix (each
 *                                  byte becomes 2 hex chars). 8 bytes = 64 bits
 *                                  of entropy = 2^32 writes per pid before a
 *                                  50% collision probability under the birthday
 *                                  bound — well past any plausible per-process
 *                                  rate. 4 supported for legacy parity.
 * @param {boolean} [opts.includePid=true]   Prefix with `<pid>.` to make stray
 *                                  tmp leftovers diagnosable to the owning
 *                                  process. Disable only if pid would be
 *                                  privacy-sensitive (none of IJFW's writes
 *                                  qualify, hence default true).
 * @returns {string} suffix WITHOUT a leading `.tmp.` — caller composes the
 *                   full tmp path (kept that way so callers can pick `.tmp.`,
 *                   `.tmp-`, or any other separator the surrounding code uses).
 */
export function tmpSuffix(opts = {}) {
  const bytes = Number.isFinite(opts.bytes) && opts.bytes > 0 ? Math.floor(opts.bytes) : 8;
  const includePid = opts.includePid !== false;
  const rand = randomBytes(bytes).toString('hex');
  return includePid ? `${process.pid}.${rand}` : rand;
}

/**
 * Convenience: build the full tmp path for a target file using the canonical
 * `.tmp.<pid>.<random>` shape. Use this when you want exactly the standard
 * pattern; for non-standard separators (e.g. existing call sites that use
 * `.tmp-<pid>-<date>`) keep building the path inline + only call tmpSuffix()
 * for the random portion.
 *
 * @param {string} targetPath
 * @param {object} [opts]    Forwarded to tmpSuffix().
 * @returns {string} `${targetPath}.tmp.${suffix}`
 */
export function tmpPathFor(targetPath, opts = {}) {
  return `${targetPath}.tmp.${tmpSuffix(opts)}`;
}
