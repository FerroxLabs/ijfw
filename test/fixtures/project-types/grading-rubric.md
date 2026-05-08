# A3 Project-Type Detection -- Grading Rubric

Synthetic, scrubbed fixtures live one-per-directory under
`test/fixtures/project-types/<domain>/<n>/`. Each fixture carries an
`expected.json` snapshot of the canonical detection result. The grader at
`mcp-server/test/grade-project-types.js` walks every fixture, runs
`detect()` against it, and compares against `expected.json` per the rules
below.

## Grading rules

A fixture passes when the detector's output satisfies **all** of:

1. **`primary_type` matches** the expected `primary_type` exactly.
2. **`secondary_types` set-equals** the expected list (order-independent;
   empty arrays match empty arrays).
3. **`confidence` >= expected `confidence_floor`** (a per-fixture floor; the
   detector is allowed to score higher, never lower).
4. **`scan_incomplete` matches** -- a fixture marked as a partial-scan smoke
   test must produce `scan_incomplete: true`; clean fixtures must produce
   `scan_incomplete: false`.
5. **`fallback_reason` matches** -- a fixture seeded with `c9Available:
   false` must produce `fallback_reason: 'c9_unavailable'`; otherwise
   `null`.

## Per-domain pass gate

Each domain (`software`, `book`, `content`, `business`, `design`) has 10
synthetic fixtures plus at least 2 real-repo fixtures. The grader emits a
per-domain pass rate covering both categories. **A domain falls below 90%
-> grader exits 1.** The 90% gate is per-domain, not aggregate, so a
strong software bucket cannot mask a weak content bucket.

## Synthetic vs. real fixtures

Both categories are required for the 90% gate to be meaningful (P3-H4):

- **Synthetic fixtures** (`<domain>/<n>/`) cover code paths -- every
  detector heuristic (manifests, dir hits, ext ratios, filename patterns)
  has at least one synthetic case exercising it.
- **Real fixtures** (`<domain>/real-<n>/`) cover real-world distribution.
  Each is hand-extracted from a real repo (open-source where possible)
  with PII, secrets, and proprietary strings scrubbed before commit. The
  shapes match the directory layout, file mix, and density of actual
  projects -- a node app's real-1 carries `package.json` + `src/` +
  `test/` instead of a contrived flat tree.

When a detector heuristic regresses, synthetic fixtures show the precise
code-path break; real fixtures show whether the regression matters in the
field. **A regression that fails synthetic-only is a unit-test failure;
a regression that fails real-only is a calibration failure.** Both ship
the gate; both must pass.

## Multi-type expectations

When a fixture mixes signals (e.g. a book project with companion code), the
detector should emit `primary_type: "mixed"` with the two strongest domains
as `secondary_types`. The fixture's `expected.json` records the canonical
shape; the grader checks set-equality on `secondary_types`.

## Authorship

All fixtures are synthetic -- no real user data, no PII, no proprietary
strings. Authored by Sean during alpha; reviewed against the rubric on each
detector change.

## Negative-space coverage

The fixture set explicitly exercises the failure modes the detector is
expected to handle gracefully:

- empty manuscripts/ directories (book domain, low-density content)
- code repos with extensive docs/ (must remain `software`, not flip to
  `content`)
- design assets inside a software repo (must remain `software`, not
  `mixed` unless design files dominate)
- ambiguous repos (must produce low confidence, not silently guess)
