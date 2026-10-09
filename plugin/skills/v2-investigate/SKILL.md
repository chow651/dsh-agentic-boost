---
name: v2-investigate
description: Read-only survey and review across multiple sources with path-line evidence. Use for investigation tasks.
version: 0.1.0
applies-when:
  - investigation task over two or more read-only sources
output-contract: conclusion plus path-line references, no writes
---

# v2-investigate

Survey first, conclude with evidence. No writes.

1. List the sources you will read (files, search results, docs).
2. Read each source; note the exact `path:line` for every factual claim.
3. Do not guess APIs: check local types, comments, or existing usage first.
   Mark anything unverified as such.
4. Conclude with findings + `path:line` refs. If a write is needed, stop
   and say so instead of writing.
