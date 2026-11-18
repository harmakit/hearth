# Hearth Studio model policy and workshop Implementation Plan

> Use subagent-driven-development for independent work and verification-before-completion for the packaged app.

**Goal.** Let the owner define which worker models Hearth can spend resources on, correct a proposed team before work begins, and recognise individual agents in the workshop.

**Architecture.** SQLite stores app and studio model policies. The planner and dispatcher use the same effective policy. Owner edits are validated on the pending plan, then applied by its existing approval transaction. Canvas draws stable characters and interprets real activity with role-specific sprites.

**Stack.** Electron, SQLite, native renderer and Canvas.

## Contracts

- `snapshot.modelPolicy = { configured: boolean, allowed: [{runtime, model, efforts}] }`; `updateModelPolicy({allowed})` saves the app-wide list, including an explicit empty choice.
- On a studio, `allowedMode: 'app'|'studio'` chooses the app list or an explicit studio list. `allowed` is the studio's saved override; `effectiveAllowed` in the snapshot is its resolved list. Automatically created and new manual agents default to `dynamic`. A dynamic role inherits the director when its effective list is empty. Existing explicit role modes are preserved. Legacy studios with a nonempty own list keep it as an override.
- Role records add optional `roleTitle` distinct from optional `name` and existing internal category `role`. The director can propose a role title and an allowed `recommendation: {runtime,model,effort}` while drafting the initial plan. For an approved initial sprint a dynamic role uses the plan recommendation while it still belongs to the effective list. This avoids a separate director call merely to select the same model. Missing or stale recommendations go through normal routing, and explicit fixed or inherited choices take priority.
- `updatePlanAgents({planId, agents:[{key,roleTitle?,name?,mode?,runtime?,model?,effort?}]})` edits known roles in a pending initial plan. It cannot add and remove role keys. The owner can use fixed, dynamic or inherited execution modes. Approval materializes exactly the edited policy for newly created roles. Keep recommendations distinct from fixed settings.
- Workshop canvas exposes `data-actor-key` and `data-actor-state` under the existing `paintRooms(content)` API. The stable visual seed combines studio and agent identities. On-screen activities may play a brief cosmetic loop, with stationary furniture and no motion at reduced motion.

## Work packages

1. **Policy and plan integration.** Add tests proving global routing, an explicit empty override, pending edits, policy validation and migration. Implement app policy, free titles and verified plan edits in core and preserve portable metadata. Run service, workflow and transfer tests.
2. **Owner UI.** Offer policy setup on first launch or first upgrade with a visible empty-list choice. Add per-app management, studio inheritance and overrides, and pending plan team editing. Show proposed and fixed models accurately. Use catalog hints where available.
3. **Workshop.** Test stable visible diversity and animation frames. Render distinct hair, clothes and details, lively typing and role work, planning symbols and occasional idle breaks. Check stationary furniture, reduced motion, offscreen suspension and rerender safety.
4. **Integration.** Wire IPC, sign the new app bundle, verify the first-run prompt, team edits and routing in a disposable Electron profile. Keep the source game unchanged. Use no Google Chrome.

## Knowledge audit

Inspect the legacy librarian, skill manifest, sourcing and training workflow read-only. Report what remains in the new app and which old mechanisms would need to be rebuilt.

The old studio used separate `train` tasks and a role knowledge base. The librarian produced source notes, while changes to installed skills and role files went through the studio engineer. The source registry recorded the resolved Git revision and licence. The current renderer and orchestrator support role descriptions and normal tasks. They do not implement automatic sourcing, a skill registry or the legacy training dependency.

## Verification

- All 84 Node tests passed, including policy persistence, pending-role corrections, a stale selection at dispatch and stable avatar frames.
- The signed 0.2.2 app passed first-run setup with two models, an independent empty studio override, editable pending roles, fixture execution with the changed model and effort, and a restart. A separate fresh profile passed the empty setup option.
- The app was verified in disposable Electron profiles. The legacy skills audit was read-only.
