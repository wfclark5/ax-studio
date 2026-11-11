import { test } from 'node:test'
import assert from 'node:assert/strict'
import { axContextArg, axNeedsServer, axSubcommand, isAx, parseForwardedPort, portForwardArgs, tunnelError } from './tunnel.ts'

test('isAx matches the program name on every OS', () => {
  assert.equal(isAx('ax'), true)
  assert.equal(isAx('/home/u/.local/bin/ax'), true)
  assert.equal(isAx('C:\\Users\\u\\AppData\\Local\\AXStudio\\bin\\ax.exe'), true)
  assert.equal(isAx('AX.EXE'), true)
  assert.equal(isAx('kubectl'), false)
  assert.equal(isAx('axe'), false)
  assert.equal(isAx('/bin/max'), false)
})

test('axSubcommand skips global flags and their values', () => {
  assert.equal(axSubcommand(['--context', 'dev', '-a', 'default', 'get', 'tasks']), 'get')
  assert.equal(axSubcommand(['--context=dev', 'get', 'tasks']), 'get')
  assert.equal(axSubcommand(['version']), 'version')
  assert.equal(axSubcommand([]), null)
  assert.equal(axSubcommand(['--help']), null)
  assert.equal(axSubcommand(['--context', 'dev', '-h']), null)
})

test('axNeedsServer is false for local subcommands and when AX_SERVER is already set', () => {
  assert.equal(axNeedsServer(['--context', 'dev', '-a', 'default', 'get', 'tasks']), true)
  assert.equal(axNeedsServer(['--context', 'dev', 'config', 'get-contexts']), true)
  assert.equal(axNeedsServer(['ssh', 'task-1', '--', '/bin/sh', '-i']), true)
  assert.equal(axNeedsServer(['version']), false)
  assert.equal(axNeedsServer(['--help']), false)
  assert.equal(axNeedsServer(['tunnel', 'list']), false)
  assert.equal(axNeedsServer([]), false)
  assert.equal(axNeedsServer(['get', 'tasks'], { AX_SERVER: 'http://127.0.0.1:1' }), false)
  assert.equal(axNeedsServer(['get', 'tasks'], { TERM: 'dumb' }), true)
})

test('axContextArg reads --context in both spellings', () => {
  assert.equal(axContextArg(['--context', 'arn:aws:eks:us-east-1:1:cluster/x', '-a', 'default', 'get', 'tasks']), 'arn:aws:eks:us-east-1:1:cluster/x')
  assert.equal(axContextArg(['--context=kind-ax', 'get', 'tasks']), 'kind-ax')
  assert.equal(axContextArg(['get', 'tasks']), '')
  assert.equal(axContextArg(['--context']), '')
})

test('portForwardArgs targets svc/ax-server in ax-system, with or without a context', () => {
  assert.deepEqual(portForwardArgs('dev'), ['--context', 'dev', 'port-forward', '-n', 'ax-system', 'svc/ax-server', ':8080'])
  assert.deepEqual(portForwardArgs(''), ['port-forward', '-n', 'ax-system', 'svc/ax-server', ':8080'])
  assert.equal(portForwardArgs('dev', 'ax-sys2')[4], 'ax-sys2')
})

test('parseForwardedPort waits for the Forwarding line', () => {
  assert.equal(parseForwardedPort(''), null)
  assert.equal(parseForwardedPort('Handling connection for 8080\n'), null)
  assert.equal(parseForwardedPort('Forwarding from 127.0.0.1:41233 -> 8080\nForwarding from [::1]:41233 -> 8080\n'), 41233)
  assert.equal(parseForwardedPort('Forwarding from [::1]:5000 -> 8080\n'), 5000)
  // Windows consoles may read UTF-16 output with CRLF.
  assert.equal(parseForwardedPort('Forwarding from 127.0.0.1:60001 -> 8080\r\n'), 60001)
})

test('tunnelError names the context and keeps the last kubectl lines', () => {
  const msg = tunnelError('dev', 'exited with status 1', 'a\nb\nerror: unable to forward port because pod is not running\n')
  assert.match(msg, /^ax-server tunnel \(kubectl port-forward -n ax-system svc\/ax-server\) on context dev: exited with status 1\n/)
  assert.ok(msg.endsWith('error: unable to forward port because pod is not running'))
  assert.equal(tunnelError('', 'no local port after 90 s', ''), 'ax-server tunnel (kubectl port-forward -n ax-system svc/ax-server) on the current context: no local port after 90 s')
})
