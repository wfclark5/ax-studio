import type { ChildProcess } from 'node:child_process'
import { AX_SYSTEM_NAMESPACE, parseForwardedPort, portForwardArgs, tunnelError, TUNNEL_TIMEOUT_MS } from '../shared/tunnel.ts'

/** Starts `kubectl args…` the way the shell runs kubectl: natively or inside WSL. */
export type StartKubectl = (args: string[]) => ChildProcess

interface Tunnel {
  child: ChildProcess
  /** Resolves to the AX_SERVER URL; rejects with a message for the user. */
  ready: Promise<string>
}

/**
 * One `kubectl port-forward` to svc/ax-server per context, shared by every ax
 * call. The forward stays up until it exits on its own, the kubeconfig
 * changes, or the app quits. A forward that exits is started again on the
 * next ax call, so a pod restart costs one failed refresh.
 */
export class Tunnels {
  private readonly tunnels = new Map<string, Tunnel>()
  private readonly start: StartKubectl
  private readonly timeoutMs: number

  constructor(start: StartKubectl, timeoutMs = TUNNEL_TIMEOUT_MS) {
    this.start = start
    this.timeoutMs = timeoutMs
  }

  /** The AX_SERVER URL for a context, starting the port-forward if needed. */
  ensure(context: string): Promise<string> {
    const have = this.tunnels.get(context)
    if (have) return have.ready
    const namespace = process.env.AX_SYSTEM_NAMESPACE || AX_SYSTEM_NAMESPACE
    let child: ChildProcess
    try {
      child = this.start(portForwardArgs(context, namespace))
    } catch (e) {
      return Promise.reject(new Error(tunnelError(context, `kubectl could not start: ${String(e)}`, '')))
    }
    let out = ''
    let err = ''
    const ready = new Promise<string>((resolve, reject) => {
      let settled = false
      const fail = (cause: string) => {
        clearTimeout(timer)
        this.tunnels.delete(context)
        if (!child.killed) child.kill()
        if (!settled) {
          settled = true
          reject(new Error(tunnelError(context, cause, err || out)))
        }
      }
      const timer = setTimeout(() => fail(`no local port after ${Math.round(this.timeoutMs / 1000)} s`), this.timeoutMs)
      child.stdout?.setEncoding('utf8').on('data', (d: string) => {
        out += d
        const port = parseForwardedPort(out)
        if (port && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(`http://127.0.0.1:${port}`)
        }
      })
      child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d))
      child.on('error', (e) => fail(e.message))
      child.on('close', (code, signal) => {
        // After the port was given out, a close means the forward dropped: the
        // next ax call starts a new one.
        this.tunnels.delete(context)
        fail(code === null ? `stopped by ${signal ?? 'signal'}` : `exited with status ${code}`)
      })
    })
    // Nobody may be waiting when a forward drops later; the rejection is reported on the next ax call.
    ready.catch(() => {})
    this.tunnels.set(context, { child, ready })
    return ready
  }

  /** Contexts with a forward that is up or starting. */
  active(): string[] {
    return [...this.tunnels.keys()]
  }

  /** Stops every forward, e.g. when the kubeconfig changes or the app quits. */
  stopAll() {
    for (const [context, t] of [...this.tunnels]) {
      this.tunnels.delete(context)
      if (!t.child.killed) t.child.kill()
    }
  }
}
