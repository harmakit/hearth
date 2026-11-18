# Hearth Studio V1 Implementation Plan

> For agentic workers use superpowers:subagent-driven-development and verification-before-completion. Each package owns its files and proves behavior before packaging.

**Goal.** A clean macOS install can create a studio, approve its first plan, run its team and inspect the project file and the next step.

**Architecture.** Keep the Electron shell, scoped provider adapters and local SQLite. The service owns studio actions, approval records, run attempts and the board. It publishes artifacts through a workspace-scoped writer.

**Stack.** Electron, Node built-ins, native HTML/CSS/JS.

**Spec.** [Hearth Studio V1](../specs/2026-11-18-hearth-studio-v1-design.md)

## Constraints and review focus

- Work in the separate app repo on `studio-v1`. Existing game repo is read-only. Run live checks only against disposable project and application profiles under `.tmp`.
- Repeat approval and restart must keep IDs and prevent duplicate tasks and file writes. Project symlinks, traversal and collisions must be rejected.
- Approval gate applies once to initialization. Later sprint plans use the studio preference. Pending approvals survive restart and remain explicit when the preference changes.
- Verify ephemeral mode before submitting any live Codex prompt. The history used to continue work belongs to Hearth.
- Validate generated plans and dependency graphs before applying the plan. Recover old database rows with field defaults.
- Audit the real first-run UX through the built app and native picker, separately from automatic protocol fixtures.

## Shared interface

`snapshot()` retains `studios`, `tasks`, `inbox` and adds `plans`, `epics`, `stories`, `sprints`, `meetings`. Extra fields default to empty for existing data.

- Studio adds `approveSprints:boolean` (default true), `lifecycle: 'draft'|'planning'|'awaiting-approval'|'active'|'paused'|'idle'|'error'`, optional `activity:string`. Agents add optional `description`. Existing task `status` still represents attempt state. Task adds `stage:'backlog'|'ready'|'in_progress'|'review'|'qa'|'done'|'blocked'`, `sprintId`, `epicId`, `storyId`, `criteria`, `dependencies:string[]`, `artifactPath`. Normal legacy tasks can derive stage.
- Workflow commands `initializeStudio({studioId})`, `decidePlan({planId,decision:'approve'|'revise',feedback?})`, `setStudioRunning({studioId,action:'pause'|'resume'|'stop'})`. Plan record `{id,studioId,kind:'initial'|'sprint',status:'draft'|'pending'|'approved'|'returned',title,goal,epic,story,agents,tasks,files,feedback?}`. Plan inbox item `kind:'plan'`, `planId`. Each nested collection is plain JSON; the draft preview can display it before creating live records. `openArtifact({taskId})` is a desktop command.
- Portable payload `{studio, tasks, inbox, plans, epics, stories, sprints, meetings}` uses the snapshot record shapes and omits runtime sessions and credentials. `service.importStudio(payload)` applies normalized records in one SQL transaction. Native commands `exportStudio({studioId,mode:'template'|'snapshot'})`, `importBundle({root,name?})`, `importLegacy({source,root,name?})` choose paths/validate in main.
- Runtime `run({...})` remains provider-neutral. Test fixtures recognize a `purpose` field in request `plan`, `task`, `review`, `director`. Artifact publisher signature `writeArtifact({root,path,content,operationId}) -> {path}` returns a validated relative path. `createStudioService` receives it as an optional callback for tests and as a scoped broker in the app.

## Task 1. Codex privacy

- [x] Assert that a fixture receives `ephemeral:true`, a server that fails to confirm it sees no prompt, and no native handle is persisted. Run the new focused test red.
- [x] Update the runtime and fixtures. Complete a turn in the installed Codex App Server using a loopback fixture and an isolated profile. Verify the stored thread list stays empty after completion and restart.

## Task 2. Autonomous workflow and board in SQLite

- [x] Write workflow tests for first plan, rejection/revision, duplicate approval, reviewer handoff, director continuation, file collision, both sprint modes, restart and prior DB rows.
- [x] Extend `core/service.mjs` with studio state and commands above. Put plan validation and prompt assembly in focused `core/` modules. Both runtimes use the same schema.
- [x] Add atomic snapshot import. Test import isolation and persistence with imported records.

## Task 3. Onboarding, settings and work views

- [x] Add tests for backward language normalization and workshop status mapping. Replace studio creation with staged onboarding, folder creation, language selector, runtime check and status-based animation. Support studio approval preferences and optional role names.
- [x] Implement `renderer/work-view.mjs` and `renderer/work.css` for board, epics/stories, sprints and meetings. Wire its dialogs and navigation into the main renderer. Expose task status and approval hints, links and reports.

## Task 4. Portability

- [x] Test versioned template and snapshot export/import, secret/path sanitization, ID/link remapping and malformed inputs. Implement `migration/transfer.mjs`.
- [x] Build a read-only legacy manifest mapper and import in a new workspace. Test a synthetic legacy copy with task/epic/sprint/meeting edges and explicit external worktree warnings. Scope selected artifacts to approved paths.

## Task 5. Desktop boundaries and release QA

- [x] Test then implement the file writer and artifact opener with collision, path traversal and symlink cases. Add the native folder creation flag and import/export file dialogs through the narrow IPC router.
- [x] Build a locally signed macOS app. Independent Computer Use QA passed native folder creation and a full first-sprint path in a clean development Electron profile. The signed bundle passed both sprint settings and persisted approval after a restart through frontend automation with a fixture.
- [x] Run live Codex in a disposable workspace. The engine produced a plan, published a starter file, finished two dependent tasks and their separate reviews, published both artifacts and recorded the retrospective. Claude and mixed runtime assignment passed with fixtures.
- [x] Exercise migration and portability in disposable copies. A read-only run against the existing legacy source imported 1162 tasks, 11 epics, 15 sprints and 3 meetings into a disposable database. The new studio stayed paused with one task marked for worktree confirmation. A copy of a 0.1 test profile preserved its two studios, task and owner response.
- [ ] Verify the Codex Desktop Recents presentation on an isolated desktop profile separately from the passing native App Server storage check.
- [ ] Run a live Claude turn after an authorized test account becomes available.

## Beyond the first V1 release

1. **Portable project files.** An explicit file selection can travel with a snapshot. Verify binary round trips, size previews, preserved file metadata and excluded secret files. Include a repository reference and working-copy state where chosen.
2. **API, local and cloud models.** Define connection identities and capabilities for OpenAI API, OpenRouter, local endpoints and subsequent adapters. Keep secrets in the OS credential store. Accept a workflow whose director and worker use different connections and preserve requested vs effective model and reasoning in its report.
3. **Skills and media.** Add the studio library, pinned skill sources and deliberate activation for executable skills. Treat image generation, text-to-speech and transcription as dedicated capabilities. Acceptance opens each selected output from the task and shows provider and usage information.
4. **Inter-studio orders.** One studio offers a scoped order, both sides can see the result criteria, and the receiving studio accepts before work enters its queue. Verify the result links back to the source order and each studio can see its own actions and artifacts.
5. **Public release.** Verify installers, onboarding on another user account, compatibility and accessible error recovery. Final game activation needs the owner’s actual relocated path. Live Claude needs an authorized account. Public release needs the owner’s licensing and publication decisions.
