import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createProjectChecks } from '../app/project-checks.mjs'
import { normalizeProjectProfile } from '../core/project-profile.mjs'

const revision = { baseOid: 'base', headOid: 'head', digest: 'content' }
const check = { id: 'build', command: 'build-tool', paths: ['game/**/*.gd'], required: true }
const profile = { id: 'game', checks: [check] }
const prepareFixtureCommand = ({ args }) => ({ command: process.execPath, args, env: {} })

test('captures each check evidence before the next check overwrites its path', async t => {
  const { root, scratch, storageDir } = await fixture(t)
  const runner = createProjectChecks({ storageDir, prepareCommand: prepareFixtureCommand })
  const contents = []
  const checks = ['before', 'after'].map(id => ({
    id, command: 'node', args: ['-e', `require("node:fs").writeFileSync("result.txt", "${id}")`], evidenceGlobs: ['result.txt'],
  }))
  await runner.runChecks({ root, scratch, revision, profile: { checks }, changedPaths: [],
    onCheck: async ({ evidencePaths }) => contents.push(await readFile(path.join(root, evidencePaths[0]), 'utf8')),
  })
  assert.deepEqual(contents, ['before', 'after'])
})

async function fixture(t) {
  const temporary = fileURLToPath(new URL('../.tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(path.join(temporary, 'project-checks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'worktree')
  const scratch = path.join(directory, 'scratch')
  const storageDir = path.join(directory, 'storage')
  await Promise.all([mkdir(root), mkdir(scratch), mkdir(storageDir)])
  return { root, scratch, storageDir }
}

test('normalizes user profiles and rejects unsafe command, paths, arguments and duplicate identifiers', () => {
  assert.deepEqual(normalizeProjectProfile({ checks: [] }).checks, [])
  assert.equal(normalizeProjectProfile(profile).checks[0].required, true)
  assert.deepEqual(normalizeProjectProfile({
    checks: [{ ...check, args: ['--headless', '--path', '.', '-s', 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd'] }],
  }).checks[0].args.at(-1), 'res://addons/gdUnit4/bin/GdUnitCmdTool.gd')
  for (const override of [
    { command: '/bin/sh' },
    { command: '../tool' },
    { paths: ['game/../outside'] },
    { evidenceGlobs: ['.git/**'] },
    { args: ['--file=/Users/other/project.godot'] },
    { args: ['--file=../project.godot'] },
    { args: ['res://../project.godot'] },
    { args: ['user://project.godot'] },
    { args: ['C:\\game\\project.godot'] },
    { timeoutMs: 0 },
  ]) {
    assert.throws(() => normalizeProjectProfile({ checks: [{ ...check, ...override }] }))
  }
  assert.throws(() => normalizeProjectProfile({ checks: [check, check] }))
})

test('selects checks from diff paths and saves bounded output for the supplied revision', async t => {
  const { root, scratch, storageDir } = await fixture(t)
  const requested = []
  const runner = createProjectChecks({
    storageDir,
    prepareCommand: input => {
      requested.push(input)
      return prepareFixtureCommand(input)
    },
  })
  const checks = [
    { ...check, args: ['-e', "process.stdout.write('ok'); process.stderr.write('x'.repeat(300000))"] },
    { ...check, id: 'assets', paths: ['assets/**'] },
  ]
  const results = await runner.runChecks({
    root, scratch, revision, profile: { checks }, changedPaths: ['game/main.gd'], network: false,
  })
  assert.deepEqual(results.map(result => [result.checkId, result.status]), [['build', 'PASS']])
  const [result] = results
  assert.deepEqual(result.revision, revision)
  assert.equal(result.required, true)
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt))
  assert.equal(requested[0].root, root)
  assert.equal(requested[0].scratch, scratch)
  assert.equal(requested[0].network, false)
  assert.ok(result.logRef.startsWith(storageDir + path.sep))
  const log = await readFile(result.logRef, 'utf8')
  assert.match(log, /ok/)
  assert.match(log, /truncat/i)
  assert.ok(Buffer.byteLength(log) <= 128 * 1024)
})

test('distinguishes an exit failure, missing capability and cancellation', async t => {
  const { root, scratch, storageDir } = await fixture(t)
  const input = {
    root, scratch, revision, changedPaths: ['game/main.gd'],
    profile: { checks: [{ ...check, args: ['-e', 'process.exit(3)'] }] },
  }
  const run = createProjectChecks({ storageDir, prepareCommand: prepareFixtureCommand })
  assert.equal((await run.runChecks(input))[0].status, 'FAIL')
  const unavailable = createProjectChecks({ storageDir })
  assert.equal((await unavailable.runChecks(input))[0].status, 'NOT ASSESSED')
  const absent = createProjectChecks({
    storageDir, prepareCommand: () => ({ command: 'hearth-missing-fixture-executable', args: [], env: {} }),
  })
  assert.equal((await absent.runChecks(input))[0].status, 'NOT ASSESSED')
  assert.equal((await run.runChecks({ ...input, signal: AbortSignal.abort() }))[0].status, 'NOT ASSESSED')
})

test('times out a process group with a live child and a cancelled run also terminates promptly', async t => {
  const { root, scratch, storageDir } = await fixture(t)
  const runner = createProjectChecks({ storageDir, prepareCommand: prepareFixtureCommand })
  const child = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 5000)'], { stdio: 'inherit' }); setInterval(() => {}, 5000)"
  const input = { root, scratch, revision, changedPaths: ['game/a.gd'] }
  const profile = { checks: [{ ...check, timeoutMs: 450, args: ['-e', child] }] }
  const start = Date.now()
  const [result] = await runner.runChecks({ ...input, profile })
  assert.equal(result.status, 'NOT ASSESSED')
  assert.match(await readFile(result.logRef, 'utf8'), /timed out/i)
  assert.ok(Date.now() - start < 2500)
  const signal = AbortSignal.timeout(150)
  const [cancelled] = await runner.runChecks({ ...input, profile, signal })
  assert.equal(cancelled.status, 'NOT ASSESSED')
  assert.match(await readFile(cancelled.logRef, 'utf8'), /cancel/i)
})

test('a generic game fixture runs build, playtest and asset checks and returns only regular relative evidence', async t => {
  const { root, scratch, storageDir } = await fixture(t)
  const fixtureProfile = JSON.parse(await readFile(new URL('./fixtures/project-profile.json', import.meta.url)))
  const fixtureScript = fileURLToPath(new URL('./fixtures/project-check-tool.mjs', import.meta.url))
  await mkdir(path.join(root, 'reports'))
  await writeFile(path.join(root, 'reports', 'previous.log'), 'Output from a previous revision')
  await symlink(path.join(root, 'reports'), path.join(root, 'reports', 'alias'))
  await symlink(storageDir, path.join(root, 'reports', 'external.log'))
  const runner = createProjectChecks({
    storageDir,
    prepareCommand: ({ command, args }) => {
      assert.equal(command, 'project-check-fixture')
      return prepareFixtureCommand({ args: [fixtureScript, ...args] })
    },
  })
  const results = await runner.runChecks({
    root, scratch, revision, profile: fixtureProfile,
    changedPaths: ['game/player.gd', 'assets/player.blend', 'assets/music.wav'],
  })
  assert.deepEqual(results.map(result => [result.checkId, result.status, result.evidencePaths]), [
    ['build', 'PASS', ['reports/build.bin']],
    ['playtest', 'PASS', ['reports/playtest.log']],
    ['assets', 'PASS', ['reports/assets.json']],
  ])
})
