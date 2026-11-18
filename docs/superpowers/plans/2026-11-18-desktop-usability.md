# Hearth Studio desktop usability Implementation Plan

> Use subagent-driven-development on independent packages and verification-before-completion on the packaged app.

**Goal.** Improve the current workspace without changing how the director creates roles or chooses models.

**Architecture.** Keep the existing SQLite service, IPC router and renderer. Add studio working windows and scoped record deletion, connect tasks to collapsible epics, and collect artifact links from the existing records. Resize details inside the native Electron window.

**Stack.** Electron, Node SQLite, native HTML/CSS and Canvas.

## Criteria

- [x] Room furniture stays fixed during animation. Active desks show brief role-specific details. Reduced motion and leaving the workshop stop the animation.
- [x] Large dialogs support resizing and a keyboard-accessible expand button. Dialog actions remain visible while the content scrolls. Short confirmations use their compact size.
- [x] Onboarding asks about the project without a mandatory category. Tasks link to their epic. Epics start collapsed and only the selected epic expands. The work area lists published and inline artifacts.
- [x] An optional per-studio schedule supports local time, selected days and overnight windows. Current attempts can finish, queued work waits outside the window and resumes when it opens. Manual pause takes precedence.
- [x] Studio deletion removes app records only, requires explicit confirmation and refuses live execution. The attached project folder is managed separately.
- [x] Build with Hearth's own macOS icon. Exercise the workflows in an isolated Electron profile.

## Shared interfaces

- Service studio `schedule: {enabled, days: [0..6], start: 'HH:mm', end: 'HH:mm'}`, with `scheduleWaiting: boolean` on the snapshot. `refreshSchedules()` evaluates the clock and awakens eligible work.
- `deleteStudio({studioId, confirmation})` explicitly deletes non-running studio DB records. Confirmation is the current studio name. The command never touches project files.
- `renderWork` adds `tab:'artifacts'` and takes `expandedEpics` as a set of IDs. Artifacts use the same task and plan open commands as reports.
- `paintRooms(content)` remains the renderer integration point. The animator follows canvas connection and active visibility.

## Validation

Review the actual macOS Chrome incident selectively and distinguish it from the packaged app. Run node:test, package with the matching checked-in icon and verify the .app signature. Test navigation and dialog dimensions from an Electron session with a disposable data profile.

Verified in the signed 0.2.1 bundle with a fixture provider. The test covers dragging, expanding, visible plan actions, opening the linked epic, accordion behavior, artifacts, schedule pause and cancellation, and deletion with the project file preserved. The full Node suite passed 74 tests. The packaged ICNS matches the checked-in asset byte for byte.
