# Cross-platform sprint and isolated executor

Approved direction on 21 November 2026. Keep the desktop host authoritative for the studio database, reviews, worktree leases and Git integration. Run project commands on a separately provisioned isolated worker. The host transfers a bounded snapshot of the task files and accepts back declared output files. Git control files, credentials and the application's data directory stay with their owners. Windows Sandbox and WSL2 are unavailable in the current Windows ARM64 guest.

## Tasks
1. Locate native Windows executables with Windows PATH semantics and identify unsupported Git before committing to project creation or a managed worktree.
2. Define the worker trust and deployment contract. Use authenticated transport, a disposable sandbox, a fresh offline working directory by default and explicit network policy. The worker receives no host mount or Git metadata. Directory traversal, special files, link aliases, undeclared outputs, timeouts and stale task revisions must fail closed. The host applies only validated outputs, and retains all existing approval and merge checks.
3. Exercise application orchestration on both platforms with the native Electron lifecycle, a deterministic test executor, real Git and temporary profiles. Separately validate command execution and deny canaries in the actual isolated worker. No provider binaries are required.
4. Verify platform file-manager actions, native notification request and power-blocker start and stop. System notification delivery and host sleep/resume are independent OS-level tests.

## Offline project checks

Hearth accepts a trusted SSH host alias in `HEARTH_CHECK_WORKER_SSH`. Provision that alias with a verified host key. Give the restricted SSH account a forced command that launches `node /absolute/path/to/scripts/hearth-check-worker.mjs`. Keep `isolated-check-worker.mjs` beside the launcher. Set `HEARTH_WORKER_IMAGE` on that host to a locally present image pinned by digest. The image must contain Node.js at `/usr/local/bin/node` and the executables used by the project's checks. Docker runs each check without a host mount, without networking and as an unprivileged user. Standard output and exit status are returned to the desktop.

Select only trusted worker operators. The worker receives the ordinary files under the current candidate directory, up to 4,000 files and 16 MiB, with Git metadata excluded. The project checkout should contain only material approved for that worker. The transport rejects requests for network access or generated evidence files. Worker mode keeps the check log and leaves the candidate unchanged. A required check fails closed when configuration, authentication, isolation or the response is invalid.

This worker covers offline project checks. Moving live agent execution and declared file outputs to the worker requires a separate application protocol. The QA fixtures do not install or invoke any provider runtime.
