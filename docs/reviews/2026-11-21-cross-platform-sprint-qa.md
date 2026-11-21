# Hearth 0.4.0 · Windows and Linux sprint acceptance

21 November 2026. The native Electron 44.11.4 ARM64 runtimes loaded the same release archive as the macOS build. Its SHA-256 was `cbc9c110c0c04f08579e84d5ab9b20f8d1367855d23fd4384a26ece596d83b0c`. The desktop scenario used the actual studio wizard, director plan and approval actions. Test projects and databases were disposable. No live provider account was used.

| Environment | Verified stages | Observed blocker |
|---|---|---|
| Windows 11 ARM64, build 26100, Portable Git 2.56.1 | Electron opened the workspace. The wizard created the Git project and delivery branch. The director planning request produced an error. The delivery branch stayed at its original commit. | The runtime reported that it could not find Claude Code. In a separate discovery test PowerShell found a temporary `claude.exe` on PATH, Hearth's automatic lookup did not, and passing the explicit path reached the version check. The runtime splits PATH on `:` and searches for an extensionless filename. |
| Ubuntu 22.04 ARM64, Git 2.34.1 | Studio creation, director plan approval and training ran with a local Claude fixture. | The implementation attempt stopped in `git worktree list --porcelain -z` because Git 2.34.1 does not recognize `-z` in this command. |
| Ubuntu 24.04 ARM64, Git 2.43.0 | Studio creation, director plan approval and training passed. The implementation task reached scoped execution. The delivery branch stayed at its initial commit. | The implementation attempt reported that process isolation is available on macOS only. Hearth interrupted the task and opened a reconciliation item. A direct invocation of the shipped isolation function returned `ISOLATION_UNAVAILABLE` on both Linux and Windows. |

Both Linux runs used Xvfb, an unprivileged container user, an offline container network and a test-only Chromium sandbox flag to accommodate Docker's namespace restrictions. The release retained its own provider isolation checks. The Windows run used the interactive Parallels session and Portable Git in the temporary test directory.

**Release outcome.** Windows and Linux did not reach sprint result acceptance or a merge. The [native file-manager checks](2026-11-19-owner-workspace-release.md) cover a separate workflow. Implementation work implied by the failures includes Windows executable discovery, an explicit minimum Git version check, and a supported process isolation strategy for each platform before repeating native acceptance.
