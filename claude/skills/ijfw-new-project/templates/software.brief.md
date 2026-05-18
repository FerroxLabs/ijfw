<!--
Filled in by ijfw-new-project / ijfw-workflow brainstorm phase, one field at a time.
Read by ijfw-roadmapper, ijfw-plan, ijfw-verify, and ijfw-ship to scope architecture, interface, and release checks.
-->

# Software Brief: [project name]

> Domain: `software` -- a runnable artifact (CLI / library / web app / API /
> mobile / desktop / browser ext) with a contract someone else depends on.
> If the only consumer is its author, it's a script, not a project yet.

## Problem

What is broken or missing today?

- **Pain:** [the friction in one sentence -- avoid solution language]
- **Status quo workaround:** [what people do instead right now]
- **Cost of the status quo:** [time / money / errors / opportunity lost]

## Users

Who actually feels the pain? Be specific; "developers" is not a user.

- **Primary user:** [role + context -- e.g., "solo SaaS founder reconciling Stripe payouts weekly"]
- **Secondary users:** [adjacent roles who'll touch it]
- **Non-users:** [who this is explicitly NOT for -- prevents scope creep]

## Solution shape

Pick exactly one primary shape; secondary surfaces are out of scope for v1.

- [ ] CLI tool
- [ ] Library / SDK
- [ ] Web app (SSR / SPA)
- [ ] HTTP / RPC API
- [ ] Mobile app (iOS / Android / cross-platform)
- [ ] Desktop app
- [ ] Browser extension
- [ ] Background service / daemon
- [ ] [other]

## Stack

- **Language:** [TypeScript / Rust / Python / Go / Swift / Kotlin / ...]
- **Runtime / target:** [Node 20+ / browser ES2022 / iOS 17+ / cargo MSRV 1.78 / ...]
- **Framework(s):** [Next.js / FastAPI / Tauri / SwiftUI / none -- vanilla / ...]
- **Test runner:** [vitest / pytest / cargo test / XCTest / ...]
- **Why this stack (one line):** [constraint that locked it in -- existing skills, ecosystem, runtime target]

## Architecture sketch

One paragraph or short ASCII diagram of the components and how data flows.

```
[ user input ] --> [ entry / cli ] --> [ core logic ] --> [ persistence ]
                                            |
                                            v
                                      [ external API ]
```

- **Modules:** [list top-level modules / packages]
- **Boundary that matters most:** [the seam that has to stay clean -- e.g., core ↔ I/O]

## Public interface contract

The surface area someone else depends on. Versioned, documented, tested.

- **CLI args / subcommands:** [`tool <subcommand> --flag value`]
- **Library exports:** [named exports / public types / default export]
- **HTTP routes:** [`GET /v1/things`, `POST /v1/things/:id` -- include status codes]
- **UI surfaces:** [pages / screens / panels users navigate]
- **Events / webhooks emitted:** [name + payload shape]

## Data shape

- **Inputs:** [what comes in -- files, args, requests, events]
- **Outputs:** [what goes out -- stdout / response / file / event]
- **Persistence:** [none / sqlite / postgres / kv / filesystem -- and schema sketch]
- **Schema versioning:** [migrations strategy / forward-compat rules]

## Dependencies

List the load-bearing ones; skip dev tooling.

| Dep | Why we lean on it | Lock-in risk |
|---|---|---|
| [stripe-node] | [primary payment integration] | [high -- pervasive in core] |
| [zod] | [runtime validation at boundaries] | [low -- swap-friendly] |
| [...] | [...] | [...] |

## Non-functional

- **Performance budget:** [p95 latency / startup time / memory ceiling -- pick what matters]
- **Accessibility floor (if UI):** WCAG AA contrast, keyboard nav, focus rings, `prefers-reduced-motion` respected
- **Security posture:** [threat model in one line + the 2-3 mitigations that follow]
- **Observability:** [logs / metrics / traces -- what we'll be able to answer in prod]
- **Backwards compatibility window:** [N minor versions / deprecation notice period]

## Distribution

How users install and run it on day one.

- **Channel:** [npm / cargo / pypi / docker / homebrew / single static binary / app store / hosted web]
- **First-run command:** [`npx tool init` / `cargo install tool && tool` / `docker run ...`]
- **Auto-update story:** [self-update / package-manager / hosted -- always latest]
- **Telemetry:** [opt-in / opt-out / none -- and what's collected]

## Constraints

Things we explicitly cannot break this milestone.

- **Back-compat:** [public API frozen at v1.x / config file format stable]
- **License:** [MIT / Apache-2.0 / GPL -- and any dependency license walls]
- **Runtime:** [must work offline / single-binary / no native build step / no root]
- **Footprint:** [bundle size ceiling / cold-start ceiling / disk usage]

## Out of scope

Named explicitly so the next milestone has somewhere to land.

- [feature / surface / integration we will NOT build this milestone]
- [...]
- [...]

## Done When

- [ ] All public-interface contracts pass automated tests (CLI args / library exports / API routes / UI flows).
- [ ] CI green on [target platforms -- e.g., macOS + Linux + Windows on Node 20 + 22].
- [ ] Distribution artifact reproduces from a clean checkout via the documented build command.
- [ ] README documents install + first-use in under 60 seconds for a new user.
- [ ] CHANGELOG.md entry written; version tagged per the project's semver policy.
