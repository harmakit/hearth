---
name: app-onboarding-questionnaire
description: Use when designing, reviewing, or implementing first-run app onboarding that asks about a user’s goal or preferences to tailor their first useful action and result.
---

# App Onboarding Questionnaire

Design the shortest path from opening the app to completing a useful task. Ask a question when its answer can change that path in a way the user can see.

## Resume and discover

Start with the current request, repository instructions such as `AGENTS.md`, existing onboarding specs, and any decisions the user already made. Verify prior work against the current branch. Record confirmed decisions, open questions, and implementation status in the project’s agreed artifacts when the task calls for them.

Trace the first launch, the main destination for returning users, and a representative core workflow. Read the product docs, navigation, design system, persistence and migration code, and any relevant permission or account integrations. Identify the audience, their starting situation, and one observable result they can achieve in a first session. Support claims about existing behavior with repository evidence. Mark assumptions about audience or value explicitly.

Ask only unresolved questions whose answers materially change the design, such as who the flow serves, what counts as success, or whether a gate is part of the product. Use Codex’s interactive question tool when the current mode exposes it and permits the question. Otherwise ask in chat. Batch related questions, offer a reasonable default, and proceed on reversible assumptions. Obtain genuine approvals through the appropriate channel and keep dependent work pending until the user answers. Honor requests for design, review, or specification without implementation.

## Design the first-use path

1. **Orient.** State the outcome a new user can reach today. Show a recognizable product surface when it helps them decide where to start.
2. **Ask.** Pick a goal, friction, or preference only when it changes a route, default, example, or next action. Map each available answer and the skipped case to its effect. Use a manageable set of plain-language options and allow users to revisit and change a selection. Omit questions when the next action is already clear.
3. **Use the app.** Guide the user through one small, authentic action in the product. Choose an example or destination from their answer. Reuse live product components when safe, and use clearly labelled sample data when the real action would require existing data, credentials, or external effects.
4. **Deliver and continue.** Make the result visible and state what happened. Put the next real action within reach. Design a usable direct path for users who skip and a clear route for users who already have data.

Use goal questions, obstacles, comparisons, proof, preference pickers, and sharing as optional patterns. Use verifiable claims and testimonials. Show progress when it accurately reflects the remaining work. Use a waiting state during real preparation and give users a recovery path when preparation fails. Account, payment, and permissions belong in the flow only when the brief calls for them or the product genuinely needs them at that point. Explain the effect before asking, defer optional access until it is useful, and design denial, decline, or cancellation where supported.

## Specify behavior, language, and presentation

Use the repository’s spec format or capture the following for each step.

| Element | Decision to record |
| --- | --- |
| Purpose and entry | The user’s task, why the step is here, and when it is shown |
| Interaction and copy | Heading, necessary context, choices, action labels, and visible feedback |
| State and routing | Default and skipped results, Back, exit or resume, validation, and system errors |
| Evidence | Where to observe success, including what each answer actually changes |

State what triggers first-run, who bypasses it, when completion is recorded, and what happens on restart. Specify precedence for legacy profiles, existing workspaces, interrupted onboarding, and explicit replay or reset where appropriate. Record what answer data is needed, its scope and lifetime, and when it is applied. Keep the first-use path free of unrequested analytics or new external integrations.

Write action labels that describe their outcome. Use existing typography, spacing, components, and interaction patterns. Make selection visible beyond color and provide an explicit control for each gesture. Specify focus behavior on navigation, keyboard traversal, accessible names and status announcements for meaningful changes. Check contrast, minimum supported viewport, and long labels. Tie motion to orientation or feedback, keep inputs available, and provide an equivalent reduced-motion path.

## Build and verify when requested

Use the product’s normal entry points and existing navigation, state, and design primitives. Keep first-run bookkeeping separate from user data. Make applying an answer or completing the flow safe to retry. Use a test profile or fixture for first-run, migrations, and reset checks.

Exercise first launch, each distinct answer effect, Skip, Back and edit, interruption and restart, completion, and returning users with existing work. Cover relevant loading, permission, and failure paths. Use the repository’s tests and launch tools to verify state and run the flow in the actual UI or an appropriate UI harness. Inspect focus, keyboard-only traversal, viewport fit, and reduced motion. For a spec or review, provide reproducible acceptance cases and distinguish observed behavior from proposed behavior.

## Source

The onboarding method draws on Adam Lyttle’s [App Onboarding Questionnaire](https://github.com/adamlyttleapps/claude-skill-app-onboarding-questionnaire/blob/5bc4786d80f2c23de60b3ba02773e919ed8fd091/SKILL.md). The source repository is [MIT licensed, copyright © 2026 Adam Lyttle](https://github.com/adamlyttleapps/claude-skill-app-onboarding-questionnaire/blob/5bc4786d80f2c23de60b3ba02773e919ed8fd091/LICENSE).
