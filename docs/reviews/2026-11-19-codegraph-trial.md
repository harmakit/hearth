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

## Live end-to-end comparison, 25 November 2026

Two independent macOS QA studios with identical initial source trees (`69cf724db4dd6ea1cce42967801ee3ee088a5031`), eight JavaScript files, the same GPT-6 Luna High engineer/reviewer and Luna XHigh director. CodeGraph 1.6.3 was installed in a temporary test tool directory. The provider ran all six actual assignments; deterministic fixtures established the two otherwise identical trained roles only. Both studios used the same required local `node --test test/sku.test.mjs` check. The first task traced the calls and the next two changed files in managed worktrees, passed required checks and independent review, and ended with owner acceptance and merge in the application.

| Task / CodeGraph | Provider input | Cached input | Uncached input | Output | Active seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trace normalizeSku / off | 66,047 | 48,384 | 17,663 | 1,051 | 26.72 |
| Trace normalizeSku / on | 49,974 | 32,512 | 17,462 | 615 | 17.73 |
| Fix normalizeSku / off | 378,353 | 256,384 | 121,969 | 4,597 | 125.67 |
| Fix normalizeSku / on | 336,439 | 193,792 | 142,647 | 4,148 | 117.27 |
| Validate positive integer quantities / off | 197,113 | 157,440 | 39,673 | 2,672 | 72.34 |
| Validate positive integer quantities / on | 164,852 | 125,184 | 39,668 | 2,083 | 58.54 |

Counts come from persisted provider usage events. Active time sums assignment, blocker recovery, review, project checks, recorded inbox processing and merge attempts; it excludes waiting for the owner. Trace was correct in both cases (all six exported callers and the unrelated helper). SKU normalization produced identical final trees and passed both existing tests independently. Both original SKU fix runs needed a technical intervention because their model shell could not run Node; both resumed with the same owner choice, then Hearth ran the checks on the frozen code. Their figures include that intervention and therefore are not a clean measure of navigation alone. The final quantity task started after the correction explaining the host checks, proceeded without any technical owner question, and passed the existing plus new regression tests (4 tests off, 3 on); both used identical source changes and all 82 additional independent assertions passed for each. Neither changed unrelated source. The two test files differ only in organization/extra coverage.

Actual CodeGraph calls took 655–920 ms in these JavaScript tasks, generating about 1.8–2.6k characters from 8 source files and 34 indexed nodes. Separate real CLI trials established that a GDScript-only tree produced zero indexed nodes in this version and that differently edited Git worktrees produced distinct correct contexts without cross-contamination. The adapter snapshots the exact requested workspace into disposable local storage, excludes hidden directories, symlinks and dependency/build trees, bounds input and output, disables telemetry, and removes the snapshot after use. Context is provided as reference text to the model, not as a new provider MCP server. Unsupported, missing, timed-out and empty indexes fall back to ordinary agent file tools; diagnostic status is recorded per attempt.

**Decision:** opt-in, disabled by default. All three matched tasks were faster with CodeGraph (small single-run sample), but input savings were mostly cached input; the clean quantity pair had essentially identical uncached input, and the SKU fix used more uncached input with CodeGraph. The supported-language and accuracy evidence is too limited to enable it automatically across studios, particularly Godot/GDScript. Application default and studio inherit/on/off are available. Production uses a separately installed `codegraph` in PATH (or an explicitly supplied absolute `HEARTH_CODEGRAPH_BIN`); it does not depend on or ship the temporary test executable. No installation or repository-wide index happens automatically.

Final native fallback check: the QA build had no explicit test binary path. In the enabled studio, both implementation and review logged `unavailable` (not installed in PATH). The live performer added the requested regression test using ordinary file tools, the actual required project checks passed for both the worktree and candidate, and owner acceptance merged the result.
