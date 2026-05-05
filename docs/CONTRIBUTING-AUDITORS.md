# Contributing a new auditor to the Trident

The Trident is the cross-audit layer in IJFW. It fans your work out to multiple AI auditors, reconciles their findings as consensus or contested, and surfaces what you're missing. The default roster covers OpenAI, Google, Anthropic, Alibaba (Qwen), and a couple of OSS options.

If you've got a model lineage that should be in the roster and isn't, this is the file that tells you how to add it. Most additions are a 10-line PR.

## When to propose a new auditor

Strong reasons:

- **A new training lineage.** The Trident's whole pitch is multi-source diversity. A new family (DeepSeek, Mistral, Llama-derivatives, Grok, anything genuinely outside the OpenAI/Google/Anthropic/Alibaba space) earns its place by adding a perspective the existing roster cannot give.
- **Reachability gap.** A user already has API keys for X but no other reachable auditor on their stack. Adding X gives them a working Trident without forcing a new install.
- **Local/zero-cost path.** A model that runs locally via Ollama or similar means zero API spend for the audit. Worth its own entry even when an existing entry covers the same lineage via a hosted API.

Weak reasons (likely to be declined):

- "It's a new model that's better than X." If it's the same lineage as something already in the roster and only competes on quality, the existing entry stays. We're not benchmarking models, we're reconciling perspectives.
- Closed-source services with no stable API. The roster needs entries that work for the next year, not the next month.
- Drive-by addition with no use case. If no one is asking for it and you don't plan to use it yourself, the maintenance burden isn't justified.

## The roster entry shape

Every auditor is a single object in `mcp-server/src/audit-roster.js`. The Qwen entry added in v1.2.4 is the canonical example for an OpenAI-compatible API:

```javascript
{
  id: 'qwen',
  family: 'oss',
  model: '',
  name: 'Qwen Code',
  invoke: 'qwen -p',
  note: 'Apache-2.0 weights (Qwen3-Coder-480B-A35B), agentic-tuned. Fork of gemini-cli; supports qwen-oauth (free Coding Plan tier), plus openai/anthropic/gemini auth-types via `qwen auth`. Diversity value for Trident: third independent training lineage outside openai/google.',
  detect: (env) => Boolean(env.QWEN_SESSION) || /(?:^|\W)qwen(?:\W|$)/i.test(env._ || ''),
  apiFallback: { provider: 'openai-compat', model: 'qwen3-coder-plus', authEnv: 'DASHSCOPE_API_KEY', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions' },
}
```

Field by field:

- **`id`**: short stable identifier. Lowercase, no spaces, no version numbers. This is what users pass to `--with <id>` and what shows up in receipts. Don't change it after shipping.
- **`family`**: training lineage. Current values: `openai`, `google`, `anthropic`, `oss`. New families are fine; just be honest. "DeepSeek-trained from scratch" is a different family from "fine-tuned Llama variant."
- **`model`**: empty string for CLI-default, or a specific model alias if the CLI takes one. Most entries leave this empty and let the upstream CLI pick.
- **`name`**: human-readable name for receipts and roster output.
- **`invoke`**: the literal CLI command. The brief is piped to stdin; use `-` or whatever the CLI's stdin flag is. If your CLI doesn't take stdin, you'll need to wrap it -- file an issue first to discuss.
- **`note`**: one paragraph explaining what makes this auditor worth fanning to. Keep it factual and specific. Diversity claim, license, training lineage, anything material.
- **`detect`**: a function that returns true when the *current process is being run by* this auditor (so it can be excluded from its own audit). Most entries check a session-scoped env var (`CODEX_SESSION_ID`, `CLAUDECODE`, `QWEN_SESSION`). Avoid env vars that signal "installed" rather than "active" -- those false-flag self-exclusion. If unsure, leave detect returning false; we'd rather double-cover than silently exclude.
- **`apiFallback`**: object with `provider`, `model`, `authEnv`, `endpoint`. The `provider` value tells the dispatcher which request shape to use. Current values:
  - `openai`: canonical OpenAI chat-completions
  - `openai-compat`: any chat-completions-shaped backend with a custom URL (DeepSeek, Kimi, Qwen-via-DashScope, Together, Groq, Fireworks, OpenRouter)
  - `google`: Gemini's `generativeLanguage` API
  - `anthropic`: Claude's `/v1/messages` with prompt-caching
  - For new providers with their own request shape, you'll need a request builder in `api-client.js` -- that's a bigger PR, file an issue first.

## Tests you need to add

Two tests in `mcp-server/test-audit-roster.js`:

1. **Roster has expected ids.** Add your `id` to the assertion list at the top of the file.
2. **`detectSelf` on session env.** If your detect rule keys off a specific env var, add a one-line test that passing that env returns your `id`.

If you used `provider: 'openai-compat'`, no separate `test-api-client.js` test is needed -- the shared codepath is already covered by the canonical openai-compat test from 1.2.4.

If your auditor needs anything beyond `openai-compat` (custom request shape, custom auth header, response with a different extraction path), you'll need to extend `buildXxx` in `api-client.js` and add a test there. Worth filing an issue first.

## Docs and installer

For a pure API-only roster entry (no CLI install instructions, no MCP merge, no platform-specific config), you don't need to touch:

- `scripts/install.sh`
- `installer/`
- Any platform skill directory

That's the whole point of the playbook -- API-only auditors are 10-line additions to one file plus tests.

For an entry that *also* ships a CLI install path (more complex), you'll want to mirror what 1.1.7+ does for OpenCode/Qwen/Kimi/OpenClaw. Open an issue and we'll sketch it together.

## What gets rejected

To save your time:

- **Closed-source SaaS with unclear API stability.** If the API can be changed under you in 90 days, the entry is going to rot.
- **Models that double-cover an existing lineage with no new angle.** If we already have an `openai`-family auditor and you're proposing another, the bar is "what's the diversity gain?"
- **Entries you don't plan to maintain.** If you're filing the PR and won't be the one debugging it when the upstream API changes, that's a maintenance liability for me. Be honest about your engagement level in the PR description.
- **Auditors that require running infrastructure.** IJFW configures behavior, never infrastructure. You can route through someone else's infrastructure (OpenRouter, Together, etc.) as an opt-in via env var, but IJFW won't ship something that requires the user to run a local proxy or sidecar.

## How to file the PR

1. Fork, create a branch.
2. Add your roster entry between an existing entry of the closest family and the OSS/fallback entries (priority placement matters -- maintained CLIs and working API fallbacks rank higher).
3. Add the two tests.
4. Run `npm test` in `mcp-server/` -- expect existing tests + your new ones to pass.
5. Update the README's auditor list if you're adding a new family.
6. Open the PR with a description that includes: which family, what diversity gain, what use case prompted you to add it, and your willingness to maintain.
7. Tag `` in the PR description.

The Qwen contribution from [@carrmjw](https://github.com/carrmjw) (PR #11) is the model for "what a great auditor PR looks like." Worth reading before you draft yours.

## Questions

If the playbook doesn't cover your case, [open an issue](https://gitlab.com/therealseandonahoe/ijfw/-/issues/new?issuable_template=auditor-proposal.yml) before writing code. The proposal template is short and helps avoid wasted PRs.
