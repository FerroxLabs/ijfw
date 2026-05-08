# D2 Symbol-Graph Extractor -- Grading Rubric

Synthetic, scrubbed fixtures live one-per-directory under
`test/fixtures/symbol-graph/<kind>/<n>/`. Each fixture carries:

- `input.json` -- synthetic observation records that the extractor consumes.
- `expected.json` -- ground-truth `{ entities: [...], edges: [...] }`.
- (real-repo fixtures only) `README.md` documenting source repo + sanitization.

The grader at `mcp-server/test/grade-symbol-graph.js` walks every fixture,
runs the D2 extractor against `input.json`, and compares the output against
`expected.json` per the rules below. This rubric mirrors the A3
project-type pattern (`test/fixtures/project-types/grading-rubric.md`).

## Input shape

```json
{
  "entries": [
    { "id": 1, "body": "...observation text...", "kind": "observation" },
    { "id": 2, "body": "...observation text...", "kind": "observation" }
  ]
}
```

Each entry is a record the extractor scans. The extractor emits
entities + edges; ids are stable strings of the form `<kind>:<name>`.

## Expected shape

```json
{
  "entities": [
    { "kind": "file",     "name": "src/auth/login.js" },
    { "kind": "function", "name": "validateToken" }
  ],
  "edges": [
    { "src": "file:src/auth/login.js", "dst": "function:validateToken", "kind": "co_occurs" }
  ]
}
```

`kind` is one of `file`, `function`, `identifier`, `error_code`, `decision`.
Edge `kind` is `co_occurs` for fixture-level grading; richer edge kinds
(supersedes, implements, references) live in the production graph but are
not graded at this level -- the extractor's job here is high-precision
entity extraction + co-occurrence linking, nothing more.

## Per-kind precision/recall gate

For each of the 5 entity kinds, the grader computes precision and recall
across the kind's fixtures (synthetic + real-repo combined):

- **precision** = correctly extracted entities of `kind` / total extracted of `kind`
- **recall**    = correctly extracted entities of `kind` / total expected of `kind`

A kind passes when **precision >= 0.90 AND recall >= 0.90**.

Edges of the matching `kind` participate in the score the same way:
predicted edges are matched against expected edges by `(src, dst, kind)`
tuple equality (order-insensitive within an undirected `co_occurs`).
Edge precision and recall are reported per kind alongside entity scores;
both must clear 0.90 for the kind to pass.

## Aggregate gate (does not exist)

There is **no aggregate gate**. A weak kind cannot be masked by a strong
one -- per-kind enforcement only. This matches the A3 detector pattern and
the V2-H5 mandate that synthetic plus real coverage both clear the same
bar for every kind.

## Synthetic vs. real-repo fixtures

Both categories are required for the 90% gate to mean anything:

- **Synthetic fixtures** (`<kind>/<n>/`, n in 1..10) cover code paths --
  every named-entity heuristic the extractor implements has at least one
  synthetic case exercising it (e.g., `function/3/` covers
  `Class.method` dot-notation; `error_code/3/` covers HTTP status codes;
  `file/3/` covers Windows backslash paths).
- **Real-repo fixtures** (`<kind>/real-<n>/`, n >= 1) cover real-world
  distribution. Each is hand-extracted from a public repo with PII,
  secrets, and proprietary strings scrubbed before commit. Observation
  text is synthesised in the style of upstream commit logs or docs;
  entity names (filenames, function names, error codes, ADR ids) are
  verbatim where they are public API surface.

When the extractor regresses, synthetic fixtures show the precise
heuristic break; real-repo fixtures show whether the regression matters
in the field. **A regression that fails synthetic-only is a unit-level
bug; a regression that fails real-only is a calibration bug.** Both ship
the gate; both must pass at >=90% precision AND >=90% recall.

## Per-kind synthetic coverage targets

| Kind         | Heuristics exercised                                                                                                   |
|--------------|------------------------------------------------------------------------------------------------------------------------|
| `file`       | posix relative, posix deeply-nested, windows backslash, posix absolute, no-extension (`Makefile`), mixed extensions, dotfiles + workflow YAML, paths with spaces, monorepo `apps/`+`packages/`, multi-language pairs |
| `function`   | camelCase, snake_case, `Class.method` dot-notation, arrow function, async, generic/templated, lifecycle hook pair, free function cross-file, getter/setter pair, Python dunder + method |
| `identifier` | UPPER_SNAKE constant, PascalCase class, TS type alias, enum value, React hook (`use*`), namespace-prefixed, Go exported type, Rust trait + struct, feature flag constant, multi-symbol cluster |
| `error_code` | Node `ERR_*`, POSIX `EBUSY`/`EEXIST`, HTTP status (`HTTP_404`/`HTTP_401`), custom uppercase, scoped (`PG_23505`), AWS-style (`ThrottlingException`), numeric sentinel (`EXIT_42`), graph-write busy, JS builtins (`TypeError`/`RangeError`), versioned long-prefix |
| `decision`   | `d-<topic>-<date>` ADR style, commit-message `#decision:` tag, planning-doc embedded, ADR-NNNN numbered, multi-decision cross-ref, supersedes prior, decision linked to error code, short id (`D42`), longform topic, decision-cluster with files + functions |

## Per-kind real-repo source repos

| Kind         | Real-1 source                                       | Real-2 source                                              |
|--------------|-----------------------------------------------------|------------------------------------------------------------|
| `file`       | `torvalds/linux` -- kernel scheduler + fork paths   | `expressjs/express` -- router + application paths         |
| `function`   | `expressjs/express` -- `Router.prototype.*`         | `nodejs/node` -- `lib/internal/process/promises.js`       |
| `identifier` | `microsoft/TypeScript` -- `lib/lib.es5.d.ts` types  | `facebook/react` -- React hooks (`useState`, `useEffect`) |
| `error_code` | `nodejs/node` -- `doc/api/errors.md` `ERR_*`        | POSIX `errno.h` -- `EBUSY`/`ENOENT`/`EACCES`              |
| `decision`   | `npryce/adr-tools` -- ADR-0001/ADR-0002             | IJFW repo `ADR-alpha-schema-reservations.md` (sanitised)  |

## Authorship + sanitization

All fixtures authored alongside the v1.3.0 D-pillar spec. Real-repo
observation copy is synthesised in the style of upstream commit logs;
no commit-author handles, PR ids, or contributor names are retained.
Entity names (filenames, function names, error codes, ADR ids) are kept
verbatim where they are public API surface, since fuzzing those would
defeat the point of distribution-fidelity testing.

PII / secrets are scrubbed before commit. The extractor's redactor (D-pillar
section 3) is **not** in the fixture path -- fixtures must be pre-scrubbed
because they ship in the repo, and redactor regressions would otherwise
silently hide leaks.

## Negative-space coverage (extractor must handle gracefully)

The fixture set explicitly avoids over-fitting to one extraction algorithm.
The extractor is expected to handle each of these without false positives:

- prose mentions of file-like words that are not files
  (e.g., "the auth flow" should not become a `file` entity)
- function-like prose verbs (e.g., "validate" alone, no parens, no caller
  context, should not become `function:validate`)
- decision-shaped phrases that are not decisions (e.g., "d-day" prose,
  "ADR-XXX" placeholders without context)
- error-shaped tokens inside source filenames
  (e.g., a file called `errors.ts` is `file:errors.ts`, not `error_code:errors`)

Real-repo fixtures distribute these traps naturally; synthetic fixtures
include at least one trap per kind via mixed observation phrasing.
