/**
 * A second Pinpoint process, for project-lock.test.js. Not a test itself.
 *
 *   append <dir> <tag> <count>   append `- <tag> <i>` to the history, one locked write each
 *   hold <dir> <ms>              take the lock, say "held", keep it for <ms>, let it go
 *   die <dir>                    take the lock, say "held", and SIGKILL itself holding it
 */
import { withProjectLock, appendHistory } from '../server/project-files.js'

const [mode, dir, a, b] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))

if (mode === 'append') {
  for (let i = 0; i < Number(b); i++) {
    // A generous wait: the other writer hammers the same lock, and a busy here fails the run.
    await appendHistory(dir, [`- ${a} ${i}`], '## day', { waitMs: 20000 })
  }
} else if (mode === 'hold') {
  await withProjectLock(dir, async () => {
    process.stdout.write('held\n')
    await sleep(Number(a))
  })
} else if (mode === 'die') {
  await withProjectLock(dir, () => {
    process.stdout.write('held\n', () => process.kill(process.pid, 'SIGKILL'))
    return new Promise(() => {})
  })
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
