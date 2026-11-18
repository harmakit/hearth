import path from 'node:path'

const defaultTimeoutMs = 120_000
const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const executable = /^[a-z0-9_][a-z0-9_.+-]{0,127}$/i
const control = /[\u0000-\u001f\u007f]/u

function list(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(name + ' must be an array')
  return value
}

function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && !control.test(value)
    && !/[\\:]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

function patterns(value, name) {
  return list(value, name).map(pattern => {
    if (!relativePath(pattern) || /^[!~]|[{}[\]()]/u.test(pattern)) {
      throw new Error(name + ' must use relative paths with optional *, ** or ? wildcards')
    }
    return pattern
  })
}

function relativeArg(arg) {
  if (typeof arg !== 'string' || control.test(arg)) return false
  const values = arg.startsWith('-') && arg.includes('=') ? [arg, arg.slice(arg.indexOf('=') + 1)] : [arg]
  return values.every(value => {
    if (value.startsWith('res://')) return relativePath(value.slice('res://'.length))
    return !/^(?:[/\\~]|[a-z][a-z\d+.-]*:\/\/|[a-z]:)/iu.test(value)
      && !value.split(/[/\\]/u).some(part => part === '..' || part.toLowerCase() === '.git')
  })
}

export function normalizeProjectProfile(profile = {}) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Project profile must be an object')
  }
  const { id = 'default' } = profile
  if (typeof id !== 'string' || !identifier.test(id)) throw new Error('Invalid project profile id')
  const ids = new Set()
  const checks = list(profile.checks, 'Checks').map(check => {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) throw new Error('Invalid project check')
    const { id, command, required = false, timeoutMs = defaultTimeoutMs } = check
    if (typeof id !== 'string' || !identifier.test(id) || ids.has(id)) throw new Error('Invalid or duplicate check id')
    ids.add(id)
    if (typeof command !== 'string' || !executable.test(command)) throw new Error('Invalid check executable name')
    const args = list(check.args, 'Arguments').map(arg => {
      if (!relativeArg(arg)) throw new Error('Invalid check argument')
      return arg
    })
    if (typeof required !== 'boolean') throw new Error('Check required must be a boolean')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error('Invalid check timeout')
    }
    return {
      id, command, args, required, timeoutMs,
      paths: patterns(check.paths, 'Check paths'),
      evidenceGlobs: patterns(check.evidenceGlobs, 'Evidence patterns'),
    }
  })
  return { id, checks }
}

export function selectProjectChecks(profile, changedPaths) {
  const changed = list(changedPaths, 'Changed paths').filter(relativePath)
  return normalizeProjectProfile(profile).checks.filter(check =>
    check.paths.length === 0 || changed.some(file => check.paths.some(pattern => path.posix.matchesGlob(file, pattern)))
  )
}
