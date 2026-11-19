# Does every Hearth project benefit from CodeGraph?

Local smoke measurement on macOS, using CodeGraph 1.6.3 installed only under `.tmp/codegraph-benchmark/tool`. No production studio or agent configuration was used. Source snapshot: `git archive 4d9996e app core renderer runtimes migration test`. A separate editorial sample contained three Markdown documents.

| Measurement | Result |
|---|---|
| Initial code index | 101 files, 2,053 nodes, 8,236 edges. 2.23 seconds wall time, about 9.9 MiB on disk. |
| Locate uses of `taskFacts` in the renderer with `rg -n 'taskFacts\(' renderer` | 14 ms, 104 output tokens. Returns the definition and three calls with source lines. An agent still needs the enclosing function names to answer who calls it. |
| `codegraph callers taskFacts` on the same tree | 225 ms, 108 output tokens. Identified both production callers, `refresh` and `openTask`, directly. Also returned import locations, including a test outside the renderer. |
| Markdown-only studio | The indexer reported three unsupported .md files and an inactive workspace. |

Token counts use o200k_base on the tool responses, with color off. Each timing is one local run. The search scopes and result content differ as shown. The experiment measures indexing overhead and retrieved text. End-to-end provider input/output tokens, cache use and accuracy over multiple tasks remain to be measured before choosing an automatic default.

Recommendation for the product: one managed executable and an index for each opted-in project with supported source files. An application default can be inherited or overridden by a studio. Preserve ordinary search when the index is absent, wrong for the current worktree, stale or unsupported. Verify worktree revision handling before connecting it to agents.
