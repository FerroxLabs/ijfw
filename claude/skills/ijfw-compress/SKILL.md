---
name: ijfw-compress
description: "Compress memory/context files into terse form. Trigger: /compress, compress file"
---

Compress the target file. Preserve all meaning. Reduce tokens.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), hedging, pleasantries.
- Fragments OK. Short synonyms (big not extensive, fix not implement a solution).
- Arrows for causality (X → Y).
- Abbreviate common terms (DB/auth/config/req/res/fn/impl/env/deps).
- Preserve EXACTLY: code blocks, URLs, file paths, commands, headings, dates, versions, technical terms.
- Only compress prose. Never touch code.

Process:
1. Back up: cp <file> <file>.original.md
2. Compress prose sections.
3. Validate: all headings preserved, all code blocks intact, all URLs unchanged.
4. Report savings as measured per-artifact: "Compressed: <before> -> <after> tokens (<percent>% saved on this artifact)". Report the MEASURED number from wc -w / token-count on the actual files. Do NOT claim a fixed percentage — savings vary widely by input shape (verbose handoffs compress further than dense memory files). v1.5.0 audit removed the legacy hardcoded "50% / 40-50%" framing from this skill in favor of measured-per-receipt reporting.
