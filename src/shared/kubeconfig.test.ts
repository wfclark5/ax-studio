import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultKubeconfig, effectiveKubeconfig, expandHome, splitKubeconfig } from './kubeconfig.ts'

const HOME = '/home/u'

test('splitKubeconfig trims, drops empties and duplicates, keeps order', () => {
  assert.deepEqual(splitKubeconfig(' a : b ::a:c ', ':'), ['a', 'b', 'c'])
  assert.deepEqual(splitKubeconfig('', ':'), [])
  assert.deepEqual(splitKubeconfig('C:\\k\\dev;C:\\k\\prod', ';'), ['C:\\k\\dev', 'C:\\k\\prod'])
})

test('expandHome expands ~ and ~/ only', () => {
  assert.equal(expandHome('~', HOME, '/'), HOME)
  assert.equal(expandHome('~/.kube/dev', HOME, '/'), '/home/u/.kube/dev')
  assert.equal(expandHome('~\\.kube\\dev', 'C:\\Users\\u', '\\'), 'C:\\Users\\u\\.kube\\dev')
  assert.equal(expandHome('/etc/kube', HOME, '/'), '/etc/kube')
  assert.equal(expandHome('~user/x', HOME, '/'), '~user/x')
})

test('effectiveKubeconfig prefers chosen, then inherited, then the default', () => {
  assert.deepEqual(effectiveKubeconfig('~/.kube/dev', '/inh', HOME, ':', '/'), ['/home/u/.kube/dev'])
  assert.deepEqual(effectiveKubeconfig('  ', '/inh:/inh2', HOME, ':', '/'), ['/inh', '/inh2'])
  assert.deepEqual(effectiveKubeconfig('', '', HOME, ':', '/'), ['/home/u/.kube/config'])
})

test('effectiveKubeconfig on Windows uses ; and backslashes', () => {
  const home = 'C:\\Users\\u'
  assert.deepEqual(effectiveKubeconfig('', '', home, ';', '\\'), ['C:\\Users\\u\\.kube\\config'])
  assert.deepEqual(effectiveKubeconfig('\\\\wsl.localhost\\Ubuntu\\home\\u\\kc.json;~\\.kube\\config', '', home, ';', '\\'),
    ['\\\\wsl.localhost\\Ubuntu\\home\\u\\kc.json', 'C:\\Users\\u\\.kube\\config'])
})

test('defaultKubeconfig', () => {
  assert.equal(defaultKubeconfig(HOME, '/'), '/home/u/.kube/config')
})
