import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { localKubeconfigCandidates, walkKubeconfigs } from './discovery.ts'

// A fake home with the usual places.
const home = mkdtempSync(join(tmpdir(), 'axs-home-'))
const tmp = mkdtempSync(join(tmpdir(), 'axs-tmp-'))
test.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }) })

const touch = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }

test('walkKubeconfigs finds kubeconfig* files and skips node_modules and .git', () => {
  touch(join(home, 'src', 'ax', '.tmp', 'kubeconfig-ax-e2e'))
  touch(join(home, 'src', 'node_modules', 'kubeconfig-no'))
  touch(join(home, '.git', 'kubeconfig-no'))
  touch(join(home, 'notes', 'kubeconfig.md'))
  touch(join(home, 'notes', 'other'))
  const found = walkKubeconfigs(home).sort()
  assert.deepEqual(found, [join(home, 'notes', 'kubeconfig.md'), join(home, 'src', 'ax', '.tmp', 'kubeconfig-ax-e2e')])
})

test('localKubeconfigCandidates: $KUBECONFIG first, then ~/.kube, tmp, then the walk; existing files only, no duplicates', () => {
  touch(join(home, '.kube', 'config'))
  touch(join(home, '.kube', 'dev'))
  touch(join(tmp, 'kubeconfig-ssm'))
  touch(join(tmp, 'unrelated'))
  const inherited = [join(home, '.kube', 'dev'), join(home, 'missing'), '~' + sep + '.kube' + sep + 'config'].join(delimiter)
  const out = localKubeconfigCandidates(home, tmp, inherited, delimiter, sep)
  assert.deepEqual(out.slice(0, 2), [join(home, '.kube', 'dev'), join(home, '.kube', 'config')])
  assert.ok(out.includes(join(tmp, 'kubeconfig-ssm')))
  assert.ok(!out.includes(join(tmp, 'unrelated')))
  assert.ok(out.includes(join(home, 'src', 'ax', '.tmp', 'kubeconfig-ax-e2e')))
  assert.equal(new Set(out).size, out.length)
})
