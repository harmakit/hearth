# Hearth Studio Agent Coach Implementation Plan

> Use subagent-driven-development and test-driven-development for independent work, and verification-before-completion before handing over the app.

**Goal.** New agents prepare for their assignment and pass review before starting production work. A director can later retrain an agent or hire a different role. The owner can see the exact skills attached.

**Architecture.** SQLite keeps a system coach per studio, training tasks, dependency edges and approved skill versions. The app supplies a scoped GitHub reader. The existing workflow dispatches training and review, and applies the reviewed output as role context.

## Contracts

- A studio has its virtual Director and one persisted Agent Coach. Use `systemRole: 'coach'`, keep internal role category `library`, and promote an existing legacy librarian where available. A new coach first completes a bootstrap `train` with the built-in sourcing and attachment guidance. The Director reviews it.
- Each newly created production role gets a `kind: 'train'` task. Its training data contains `{ targetAgentId, topics, objective, bootstrap? }`. The worker is the coach and the reviewer is the Director. Production dependencies require `train.stage === 'done'`. Preserve existing production work on upgrade. Manual hires and manually started work must use the same gate.
- Planner role records can provide `trainingTopics: string[]` of repo tags/search terms. Director next-step actions add `train` (prepare an existing agent) and `hire` (create a role and prepare it before assigning the work). They reference an eligible target task by key and carry an objective and topics. Validate the target, role and dependencies before changing the board.
- `findSkills({topics,minStars,signal}) -> Promise<{candidates,warnings}>` uses public, nonarchived GitHub repository search with a default threshold of 10000 stars and descending star order. Inspect a bounded number of git trees, resolve the default branch to an immutable commit and read matching `SKILL.md` pinned to it.
- Candidate `{id,repo,commit,path,title,stars,license,url,content}`. The coach selects known candidate IDs and builds an assignment guide. The trainee exercises it where applicable. The reviewer sees the evidence before acceptance. When no candidate matches, the training can use a project-specific guide and record that outcome. Network failures are visible and do not masquerade as a completed search.
- Approved skill records add `studioId` and are exposed in `snapshot.skills`; role records carry `skillIds` and training readiness. A task gets the pinned approved material in its prompt context. Treat imported text as source material. Scope shell/network and project-write permissions separately. Pinning Markdown stores content and provenance, not executable dependencies.
- Studio settings expose `skillMinStars` with default 10000. Optional native command `searchSkillRepositories({studioId,topics})` returns public candidates with display metadata only, for owner visibility. Source import from the old app is read-only.

## Work packages

1. **GitHub reader.** Write tests for repository search request encoding, stars sorting/filtering, bounded immutable tree and blob resolution, empty results, cancellation and rate limits. Implement in `app/github-skills.mjs` with injected fetch and no external scripts.
2. **Coach and training state.** Write tests for bootstrap, a train dependency for every hire, review rejection, approval with attached pinned skills, actual task prompts and mid-sprint retraining/hire. Implement in `core/`, reusing the persisted workflow. Wired through `createStudioService({findSkills})`.
3. **Owner views.** Show training tasks and readiness, the mandatory coach, dependency reasons and pinned versions. Add a reusable skill library view and studio threshold setting. Test functional rendering.
4. **Integration.** Wire app service and IPC, sign the app, test with GitHub/provider fixtures in separate Electron and SQLite profiles. Verify public search on a safe narrow query where available. Re-check legacy studio read-only.
5. **Legacy gap audit.** Independent agents examine runtime, process, delivery, owner experience and knowledge. Consolidate deduplicated findings with codes and source links. The owner chooses the follow-up scope.

## Verification

- All 104 Node tests passed. The cases cover startup coaching, required training for manual and planned hires, review and exercise, retraining and hiring mid-sprint, failure and retry, restart and portable evidence.
- The signed 0.2.3 .app passed an isolated Electron run with a fixture provider. The coach and all new roles completed their training before the dependent production work. The app restored readiness after restart.
- A live public GitHub search for React returned matching candidates with immutable commit IDs and the configured star threshold. The reader also surfaced a size-limit warning for one repository.
- A copy of a 0.2.2 test profile retained its roles, model policy and tasks and gained one coach per studio.
- The [consolidated audit](../../legacy-gap-audit-2026-11-18.md) lists 39 findings against baseline `8721edd`. The legacy repository was inspected read-only.
