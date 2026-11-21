# SSH worker, notifications, and suspend acceptance

21 November 2026. Electron 44.11.4 ARM64 ran the current Hearth source archive on Windows 11 in Parallels and Ubuntu 22.04 under OrbStack. Both clients used the system OpenSSH client, a dedicated configuration, and an ephemeral client key. The server used a pinned ephemeral host key and a forced worker command. The worker executed in a disposable non-root Docker container with network disabled and no host mount. A deterministic runtime fixture triggered Hearth events. No provider binary was installed.

| Verification | Windows 11 ARM64 | Ubuntu 22.04 ARM64 |
|---|---|---|
| Real SSH and project checks | PASS. The native OpenSSH client authenticated across the Parallels private network. Hearth recorded exit 0 and the expected worker output. | PASS. The native OpenSSH client authenticated through the OrbStack host endpoint. Hearth recorded exit 0 and the expected worker output. |
| Worker input isolation | The worker read the Unicode-named fixture file. The project Git marker and the client's original path were absent in the worker. | The same assertions passed. |
| Notification delivery | The Windows notification database contained two records matching the exact QA title. The observer did not find a visible matching banner or a visible matching notification-center element. | The session bus recorded Hearth's exact `Notify` title. X11 independently reported the Dunst notification window mapped as `IsViewable`. |
| Guest OS sleep and resume | Windows reported S0 available. The Win32 guest suspend request returned error 50. Neither the Windows Kernel-Power filter nor Electron observed a corresponding suspend or resume event. | The container exposes neither a guest power-state interface nor a system D-Bus socket. OrbStack shares its Linux kernel across workloads, so this test did not request host sleep. |
| VM interruption continuity | PASS for Parallels Suspend/Resume. The same Hearth PID continued an active task and recorded its result after the VM resumed. No Electron guest-power event occurred. | A container restart was outside the sleep test. |

The test introduced `HEARTH_CHECK_WORKER_SSH_CONFIG`, an optional absolute path to a standalone OpenSSH configuration. This allows isolated profiles, pinned keys and explicit worker ports while preserving the user's usual SSH configuration. [Worker setup](../superpowers/plans/2026-11-21-cross-platform-executor.md).
