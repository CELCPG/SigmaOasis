import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * v4.2: the web trigger's weights are a JSON module (lib/webTrigger.model.json),
 * and every script that compiles app code with a bare `tsc` command line — the
 * evals, the benches, trace export — must be told JSON is a module. On the
 * night 4.2 was built, eval:agent failed at its compile step with TS2732 on the
 * first 4.2 run; the app's own builds (Vite, esbuild) never noticed. A script
 * that builds from a tsconfig inherits the flag from it.
 */
test('every script that runs tsc by hand resolves JSON modules', () => {
  const dir = join(__dirname, '..', '..', 'scripts')
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => {
      const text = readFileSync(join(dir, f), 'utf8')
      return /typescript\/bin\/tsc\b/.test(text) && /--outDir/.test(text) && !/-p tsconfig/.test(text) && !/--resolveJsonModule/.test(text)
    })
  assert.deepEqual(missing, [], `add --resolveJsonModule to: ${missing.join(', ')}`)
})
