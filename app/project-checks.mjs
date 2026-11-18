import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { glob, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { selectProjectChecks } from '../core/project-profile.mjs'

const MAX_LOG_BYTES = 128 * 1024
const TRUNCATED = '\n[output truncated]\n'
const MAX_OUTPUT_BYTES = MAX_LOG_BYTES - 1024

function boundedOutput() {
  const chunks = []
  let length = 0
  let truncated = false
  return {
    append(chunk) {
      const kept = Math.min(chunk.length, MAX_OUTPUT_BYTES - length)
      if (kept > 0) chunks.push(chunk.subarray(0, kept))
      length += kept
      if (kept < chunk.length) truncated = true
    },
    log(status, detail) {
      return Buffer.concat([
        Buffer.from(status + '\n' + detail + '\n'),
        ...chunks,
        Buffer.from(truncated ? TRUNCATED : ''),
      ])
    },
  }
}

function killProcessGroup(child) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') return error
  }
}

function runCommand({ command, args, env }, root, signal, capture) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve({ interrupted: true })
    const child = spawn(command, args, {
      cwd: root, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let error
    let stopping = false
    const abort = () => {
      if (stopping || !child.pid) return
      stopping = true
      const failure = killProcessGroup(child)
      if (!failure) return
      error ??= failure
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    child.stdout.on('data', capture.append)
    child.stderr.on('data', capture.append)
    child.once('error', failure => { error = failure })
    child.once('exit', abort)
    child.once('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', abort)
      resolve({ code, terminationSignal, error, interrupted: signal.aborted })
    })
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function prepareScopedCommand(prepareCommand, input) {
  const { signal } = input
  signal.throwIfAborted()
  const { promise, reject } = Promise.withResolvers()
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([prepareCommand(input), promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function evidenceSnapshot(root, patterns, signal) {
  const files = new Map()
  if (patterns.length === 0) return files
  const canonicalRoot = await realpath(root)
  for await (const match of glob(patterns, { cwd: canonicalRoot, exclude: ['**/.git', '**/.git/**'] })) {
    signal.throwIfAborted()
    const candidate = path.join(canonicalRoot, match)
    try {
      const stat = await lstat(candidate, { bigint: true })
      if (stat.isFile() && await realpath(candidate) === candidate) {
        files.set(match, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
    }
  }
  return files
}

export function createProjectChecks({ storageDir, prepareCommand } = {}) {
  return {
    async runChecks({ root, scratch, revision, profile, changedPaths, signal, network = false, verify, onCheck }) {
      const checks = selectProjectChecks(profile, changedPaths)
      if (checks.length === 0) return []
      await mkdir(storageDir, { recursive: true, mode: 0o700 })
      const results = []
      for (const { id: checkId, command, args, required, timeoutMs, evidenceGlobs } of checks) {
        await verify?.()
        const startedAt = new Date().toISOString()
        const capture = boundedOutput()
        const timeout = AbortSignal.timeout(timeoutMs)
        const checkSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        const interruption = () => signal?.aborted ? 'Check cancelled' : 'Check timed out'
        let status = 'NOT ASSESSED'
        let detail = 'Scoped command execution is unavailable'
        let evidencePaths = []
        try {
          checkSignal.throwIfAborted()
          if (prepareCommand && process.platform !== 'win32') {
            const scoped = await prepareScopedCommand(prepareCommand, {
              command, args, root, scratch, network, signal: checkSignal,
            })
            if (scoped) {
              const before = await evidenceSnapshot(root, evidenceGlobs, checkSignal)
              const outcome = await runCommand(scoped, root, checkSignal, capture)
              if (outcome.interrupted) detail = interruption()
              else if (outcome.error) detail = 'Unable to start the check (' + (outcome.error.code ?? 'unknown') + ')'
              else if (outcome.terminationSignal) detail = 'Check terminated by ' + outcome.terminationSignal
              else {
                const after = await evidenceSnapshot(root, evidenceGlobs, checkSignal)
                checkSignal.throwIfAborted()
                evidencePaths = [...after.keys()].filter(file => before.get(file) !== after.get(file)).sort()
                status = outcome.code === 0 ? 'PASS' : 'FAIL'
                detail = 'Check exited with code ' + outcome.code
              }
            }
          }
        } catch (error) {
          detail = checkSignal.aborted ? interruption() : 'Check could not be assessed: ' + String(error.message ?? error).slice(0, 180)
          evidencePaths = []
        }
        const logRef = path.resolve(storageDir, randomUUID() + '.log')
        await writeFile(logRef, capture.log(status, detail), { mode: 0o600, flag: 'wx' })
        await verify?.()
        const result = {
          checkId, revision, status, required, logRef, startedAt, finishedAt: new Date().toISOString(), evidencePaths,
        }
        await onCheck?.(result)
        results.push(result)
      }
      return results
    },
  }
}
