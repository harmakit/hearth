import { mkdir, writeFile } from 'node:fs/promises'

const jobs = {
  build: ['build.bin', Buffer.from([0, 255, 1])],
  playtest: ['playtest.log', 'Fixture playtest completed\n'],
  assets: ['assets.json', '{"fixtureAssets":"valid"}\n'],
}
const job = jobs[process.argv[2]]
if (!Array.isArray(job)) throw new Error('Unknown fixture check')
const [name, content] = job
await mkdir('reports', { recursive: true })
await writeFile('reports/' + name, content)
