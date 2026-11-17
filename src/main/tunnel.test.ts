import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Tunnels } from './tunnel.ts'

/** A stand-in for a spawned kubectl: writable stdout/stderr, a kill that records itself. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  args: string[]
  constructor(args: string[]) {
    super()
    this.args = args
  }
  kill() {
    this.killed = true
    return true
  }
  /** What kubectl prints once the forward is up. */
  forward(port: number) {
    this.stdout.write(`Forwarding from 127.0.0.1:${port} -> 8080\nForwarding from [::1]:${port} -> 8080\n`)
  }
  exit(code: number) {
    this.emit('close', code, null)
  }
}

function harness(timeoutMs = 50) {
  const children: FakeChild[] = []
  const tunnels = new Tunnels((args) => {
    const c = new FakeChild(args)
    children.push(c)
    return c as unknown as ChildProcess
  }, timeoutMs)
  return { children, tunnels }
}

const tick = () => new Promise((r) => setImmediate(r))

test('ensure starts one port-forward per context and shares it', async () => {
  const { children, tunnels } = harness()
  const a = tunnels.ensure('dev')
  const b = tunnels.ensure('dev')
  const c = tunnels.ensure('prod')
  assert.equal(children.length, 2)
  assert.deepEqual(children[0].args, ['--context', 'dev', 'port-forward', '-n', 'ax-system', 'svc/ax-server', ':8080'])
  assert.deepEqual(children[1].args.slice(0, 2), ['--context', 'prod'])
  children[0].forward(41233)
  children[1].forward(41234)
  assert.equal(await a, 'http://127.0.0.1:41233')
  assert.equal(await b, 'http://127.0.0.1:41233')
  assert.equal(await c, 'http://127.0.0.1:41234')
  assert.deepEqual(tunnels.active().sort(), ['dev', 'prod'])
  // A later call reuses the running forward.
  assert.equal(await tunnels.ensure('dev'), 'http://127.0.0.1:41233')
  assert.equal(children.length, 2)
})

test('a forward that exits before the port is rejected with kubectl output, and is retried next time', async () => {
  const { children, tunnels } = harness()
  const p = tunnels.ensure('dev')
  children[0].stderr.write('error: unable to forward port because pod is not running. Current status=Pending\n')
  await tick()
  children[0].exit(1)
  await assert.rejects(p, (e: Error) => {
    assert.match(e.message, /on context dev: exited with status 1\n/)
    assert.match(e.message, /pod is not running/)
    return true
  })
  assert.deepEqual(tunnels.active(), [])
  void tunnels.ensure('dev').catch(() => {})
  assert.equal(children.length, 2)
})

test('a forward that prints no port in time is killed and rejected', async () => {
  const { children, tunnels } = harness(20)
  await assert.rejects(tunnels.ensure('slow'), /no local port after 0 s/)
  assert.equal(children[0].killed, true)
  assert.deepEqual(tunnels.active(), [])
})

test('a forward that drops after it was up is forgotten, so the next call starts a new one', async () => {
  const { children, tunnels } = harness()
  const p = tunnels.ensure('dev')
  children[0].forward(5000)
  assert.equal(await p, 'http://127.0.0.1:5000')
  children[0].exit(1)
  await tick()
  assert.deepEqual(tunnels.active(), [])
  const again = tunnels.ensure('dev')
  assert.equal(children.length, 2)
  children[1].forward(5001)
  assert.equal(await again, 'http://127.0.0.1:5001')
})

test('stopAll kills every forward', async () => {
  const { children, tunnels } = harness()
  void tunnels.ensure('a').catch(() => {})
  void tunnels.ensure('b').catch(() => {})
  tunnels.stopAll()
  assert.deepEqual(children.map((c) => c.killed), [true, true])
  assert.deepEqual(tunnels.active(), [])
})

test('a start that throws is reported, not thrown', async () => {
  const tunnels = new Tunnels(() => {
    throw new Error('spawn kubectl ENOENT')
  })
  await assert.rejects(tunnels.ensure('dev'), /kubectl could not start: Error: spawn kubectl ENOENT/)
})
