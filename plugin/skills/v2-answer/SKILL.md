---
name: v2-answer
description: Minimal Q&A shape with evidence citation. Default for simple qa tasks; no check runner needed.
version: 0.1.0
applies-when:
  - qa task answerable from repo or docs without code changes
output-contract: answer plus path-line citations
---

# v2-answer

Answer briefly, cite everything.

1. Answer the question directly in as few lines as possible.
2. Cite each factual claim as `path:line`.
3. If the answer needs a code change, say so and stop — switch to the
   code-change route instead of editing.
