import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultKubeconfig, effectiveKubeconfig, expandHome, isKubeconfigName, LOCAL_SOURCE, parseContextNames, parseDefaultDistro, parseFoundKubeconfigs,
  parseWslDistros, parseWslPath, shellQuote, splitKubeconfig, windowsToWslPath, wslCommandLine, wslKubeconfigTarget, wslSource, wslSourceDistro, wslUncPath,
} from './kubeconfig.ts'

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

test('parseWslPath recognises UNC and Linux paths only', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\.kube\\config'), { distro: 'Ubuntu', linuxPath: '/home/u/.kube/config' })
  assert.deepEqual(parseWslPath('\\\\wsl$\\Ubuntu-22.04\\tmp\\kc'), { distro: 'Ubuntu-22.04', linuxPath: '/tmp/kc' })
  assert.deepEqual(parseWslPath('//wsl.localhost/Ubuntu/home/u/x'), { distro: 'Ubuntu', linuxPath: '/home/u/x' })
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', linuxPath: '/' })
  assert.deepEqual(parseWslPath('/home/u/.kube/config'), { distro: '', linuxPath: '/home/u/.kube/config' })
  assert.equal(parseWslPath('C:\\Users\\u\\.kube\\config'), null)
  assert.equal(parseWslPath('~/.kube/config'), null)
  assert.equal(parseWslPath('\\\\server\\share\\kc'), null)
})

test('windowsToWslPath and wslUncPath', () => {
  assert.equal(windowsToWslPath('C:\\Users\\u\\kc.yaml'), '/mnt/c/Users/u/kc.yaml')
  assert.equal(windowsToWslPath('d:/work/kc'), '/mnt/d/work/kc')
  assert.equal(windowsToWslPath('/home/u/kc'), '/home/u/kc')
  assert.equal(wslUncPath('Ubuntu', '/home/u/.kube/config'), '\\\\wsl.localhost\\Ubuntu\\home\\u\\.kube\\config')
})

test('wslKubeconfigTarget picks the distro and converts every path', () => {
  assert.equal(wslKubeconfigTarget(['C:\\k\\dev'], 'Ubuntu'), null)
  assert.equal(wslKubeconfigTarget([], 'Ubuntu'), null)
  assert.deepEqual(wslKubeconfigTarget(['\\\\wsl.localhost\\Deb\\home\\u\\kc', 'C:\\k\\dev'], 'Ubuntu'),
    { distro: 'Deb', linuxPaths: ['/home/u/kc', '/mnt/c/k/dev'] })
  assert.deepEqual(wslKubeconfigTarget(['/tmp/kc', '\\\\wsl$\\Deb\\x'], 'Ubuntu'), { distro: 'Deb', linuxPaths: ['/tmp/kc', '/x'] })
  assert.deepEqual(wslKubeconfigTarget(['/tmp/kc'], 'Ubuntu'), { distro: 'Ubuntu', linuxPaths: ['/tmp/kc'] })
})

test('shellQuote', () => {
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('a b'), `'a b'`)
})

test('wslCommandLine exports KUBECONFIG, execs the program and skips PATH', () => {
  const s = wslCommandLine({ kubeconfig: ['/home/u/kc', '/tmp/k2'], program: 'kubectl', args: ['get', 'a b'], cwd: 'C:\\ax',
    extra: { PATH: 'C:\\x', KIND_EXPERIMENTAL_PROVIDER: 'podman', 'bad-key': '1' } })
  const lines = s.split('\n')
  assert.equal(lines[0], `export KUBECONFIG='/home/u/kc:/tmp/k2'`)
  assert.ok(lines[1].startsWith('export PATH="$HOME/.local/bin'))
  assert.equal(lines[2], `export KIND_EXPERIMENTAL_PROVIDER='podman'`)
  assert.equal(lines[3], `cd '/mnt/c/ax' || exit 1`)
  assert.equal(lines[4], `exec 'kubectl' 'get' 'a b'`)
  assert.equal(lines.length, 5)
  const script = wslCommandLine({ kubeconfig: ['/k'], commandLine: 'set -e\nkind get clusters' })
  assert.ok(script.endsWith('set -e\nkind get clusters'))
  assert.ok(wslCommandLine({ kubeconfig: ['/k'], cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\ax' }).includes(`cd '/home/u/ax' || exit 1`))
})

test('parseWslDistros and parseDefaultDistro handle UTF-16 noise', () => {
  const utf16 = 'U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000D\u0000e\u0000b\u0000\r\u0000\n\u0000'
  assert.deepEqual(parseWslDistros(utf16), ['Ubuntu', 'Deb'])
  assert.deepEqual(parseWslDistros('Ubuntu\r\n\r\n'), ['Ubuntu'])
  assert.equal(parseDefaultDistro('  NAME  STATE  VERSION\r\n* Ubuntu  Running  2\r\n  Deb  Stopped  2\r\n'), 'Ubuntu')
  assert.equal(parseDefaultDistro('  NAME\r\n  Deb  Stopped  2\r\n'), null)
})

test('parseFoundKubeconfigs dedupes, splits contexts, drops files without one and maps the value', () => {
  const out = parseFoundKubeconfigs('wsl:Ubuntu', '/home/u/.kube/config\tkind-ax,dev\n/tmp/kc\t\n/home/u/.kube/config\tkind-ax\nnot-a-path\tx\n',
    (p) => wslUncPath('Ubuntu', p))
  assert.deepEqual(out, [
    { source: 'wsl:Ubuntu', path: '/home/u/.kube/config', value: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.kube\\config', contexts: ['kind-ax', 'dev'] },
  ])
  assert.deepEqual(parseFoundKubeconfigs('local', '/a\tx\n', (p) => p), [{ source: 'local', path: '/a', value: '/a', contexts: ['x'] }])
})

test('parseContextNames', () => {
  assert.deepEqual(parseContextNames('a\r\nb\n\n'), ['a', 'b'])
  assert.deepEqual(parseContextNames(''), [])
})

test('kubeconfig sources and names', () => {
  assert.equal(LOCAL_SOURCE.id, 'local')
  assert.deepEqual(wslSource('Ubuntu'), { id: 'wsl:Ubuntu', label: 'WSL · Ubuntu' })
  assert.equal(wslSourceDistro('wsl:Ubuntu-22.04'), 'Ubuntu-22.04')
  assert.equal(wslSourceDistro('local'), null)
  assert.equal(wslSourceDistro('wsl:'), null)
  assert.ok(isKubeconfigName('kubeconfig-ax-e2e'))
  assert.ok(isKubeconfigName('KubeConfig.yaml'))
  assert.ok(!isKubeconfigName('config'))
  assert.ok(!isKubeconfigName('my-kubeconfig'))
})
