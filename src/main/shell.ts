import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import DOCKER_SHIM from './docker-shim.sh?raw'
import type { CommandResult, ContainerRuntime, PipeRequest, RunRequest, SessionRequest, StreamRequest } from '../shared/api'
import { effectiveKubeconfig, expandHome, splitKubeconfig, type KubeconfigInfo } from '../shared/kubeconfig'

const isWin = process.platform === 'win32'

/**
 * Apps launched from Finder, the Dock, or a desktop launcher don't inherit
 * the user's shell PATH, so ax, kubectl, podman and go would be missing.
 * Ask a login shell once and merge in the usual tool directories.
 */
function loginPath(): string {
  const base = process.env.PATH ?? ''
  if (isWin) return base
  try {
    const sh = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(sh, ['-ilc', 'printf "__AXPATH__%s" "$PATH"'], { timeout: 4000, encoding: 'utf8' })
    const i = out.lastIndexOf('__AXPATH__')
    if (i >= 0) return out.slice(i + 10).trim() + delimiter + base
  } catch {
    // Fall back to the inherited PATH plus well-known locations.
  }
  return base
}

const home = homedir()
const extra = isWin
  ? [join(home, 'go', 'bin'), join(home, 'scoop', 'shims')]
  : [join(home, 'go', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/go/bin',
     join(home, 'google-cloud-sdk', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']

const PATH = [...new Set([...loginPath().split(delimiter), ...extra].filter(Boolean))].join(delimiter)

export const env: NodeJS.ProcessEnv = { ...process.env, PATH }

/** KUBECONFIG as the app was launched: a launcher script may have set it. */
const inheritedKubeconfig = process.env.KUBECONFIG ?? ''
/** The kubeconfig picked in Settings; '' falls back to the inherited value, then ~/.kube/config. */
let chosenKubeconfig = ''

/**
 * Points every spawned ax, kubectl and shell step at the given kubeconfig
 * file(s). The user's own kubeconfig and global context stay untouched.
 */
export function setKubeconfig(value: string): KubeconfigInfo {
  chosenKubeconfig = value.trim()
  const chosen = splitKubeconfig(chosenKubeconfig, delimiter).map((p) => expandHome(p, home, sep)).join(delimiter)
  if (chosen) env.KUBECONFIG = chosen
  else if (inheritedKubeconfig) env.KUBECONFIG = inheritedKubeconfig
  else delete env.KUBECONFIG
  return kubeconfigInfo()
}

export function kubeconfigInfo(): KubeconfigInfo {
  const effective = effectiveKubeconfig(chosenKubeconfig, inheritedKubeconfig, home, delimiter, sep)
  return {
    chosen: chosenKubeconfig,
    inherited: inheritedKubeconfig,
    defaultPath: join(home, '.kube', 'config'),
    effective,
    missing: effective.filter((p) => !existsSync(p)),
  }
}

export function which(program: string): string | null {
  if (program.includes('/') || program.includes('\\')) return existsSync(program) ? program : null
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat(['']) : ['']
  for (const dir of PATH.split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, program + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

export function run(req: RunRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    const program = which(req.program) ?? req.program
    let child: ChildProcess
    try {
      child = spawn(program, req.args, { cwd: req.cwd, env: { ...env, ...req.env }, windowsHide: true })
    } catch (e) {
      resolve({ status: 127, stdout: '', stderr: String(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ status: 127, stdout, stderr: stderr + `${req.program}: ${e.message}` }))
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    if (req.stdin !== undefined) child.stdin?.end(req.stdin)
    else child.stdin?.end()
  })
}

/**
 * Runs `program from… | program to…` with raw bytes in between, e.g. a tar
 * stream from one task's `ax ssh` into another's. Fails if either side does.
 */
export function pipe(req: PipeRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    const program = which(req.program) ?? req.program
    let stdout = ''
    let stderr = ''
    let failed: number | null = null
    let left = 2
    const done = (code: number | null) => {
      if (code !== 0 && failed === null) failed = code ?? 1
      if (--left === 0) resolve({ status: failed ?? 0, stdout, stderr })
    }
    const from = spawn(program, req.from, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const to = spawn(program, req.to, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    from.stdout.pipe(to.stdin)
    // A reader that quits early shouldn't crash the main process with EPIPE.
    to.stdin.on('error', () => {})
    from.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    to.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    to.stdout.setEncoding('utf8').on('data', (d) => (stdout += d))
    for (const child of [from, to]) {
      // 'close' may or may not follow 'error'; count each child once.
      let ended = false
      const end = (code: number | null) => { if (!ended) { ended = true; done(code) } }
      child.on('error', (e) => { stderr += `${req.program}: ${e.message}\n`; end(127) })
      child.on('close', end)
    }
    // If the writer dies, don't leave the reader waiting forever.
    from.on('close', (code) => code !== 0 && to.stdin.destroy())
  })
}

/** The shell used for cluster setup steps. Steps are POSIX sh; on Windows prefer Git Bash. */
function shellFor(commandLine: string): [string, string[]] {
  if (!isWin) return ['/bin/sh', ['-c', commandLine]]
  const bash = which('bash')
  return bash ? [bash, ['-lc', commandLine]] : ['cmd.exe', ['/d', '/s', '/c', commandLine]]
}

const streams = new Map<string, ChildProcess>()

export function stream(req: StreamRequest, onLine: (line: string) => void, onExit: (status: number) => void) {
  const [sh, args] = shellFor(req.commandLine)
  // Its own process group on unix, so cancel reaches the whole pipeline (make, go, kind…).
  const child = spawn(sh, args, { cwd: req.cwd, env: { ...env, ...req.env }, windowsHide: true, detached: !isWin })
  streams.set(req.id, child)
  // stdout and stderr share one buffer each so partial lines are never split.
  const buffers = { out: '', err: '' }
  const feed = (key: 'out' | 'err') => (chunk: string) => {
    buffers[key] += chunk
    const parts = buffers[key].split(/\r?\n/)
    buffers[key] = parts.pop() ?? ''
    for (const p of parts) onLine(p)
  }
  child.stdout?.setEncoding('utf8').on('data', feed('out'))
  child.stderr?.setEncoding('utf8').on('data', feed('err'))
  child.on('error', (e) => onLine(`error: ${e.message}`))
  child.on('close', (code, signal) => {
    for (const k of ['out', 'err'] as const) if (buffers[k]) onLine(buffers[k])
    streams.delete(req.id)
    onExit(code ?? (signal ? 130 : 1))
  })
}

export function cancel(id: string) {
  const child = streams.get(id)
  if (!child || child.killed) return
  if (isWin || !child.pid) child.kill()
  else {
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {
      child.kill('SIGINT')
    }
  }
}

/**
 * A kubeconfig that only sets current-context, prepended to KUBECONFIG, so
 * kubectl calls in the Makefile hit the chosen cluster without changing the
 * user's global context.
 */
export function kubeconfigFor(context: string): string {
  const file = join(tmpdir(), `axstudio-kubeconfig-${context.replace(/[^\w.-]/g, '_')}.yaml`)
  writeFileSync(file, `apiVersion: v1\nkind: Config\ncurrent-context: ${JSON.stringify(context)}\n`)
  const base = env.KUBECONFIG || join(home, '.kube', 'config')
  return [file, base].join(delimiter)
}

/**
 * Finds the container runtime kind should use. kind, Substrate's and AX's
 * scripts call `docker`; on podman-only machines we put a shim first on PATH
 * and switch kind to its podman provider.
 */
export function containerRuntime(shimDir: string): ContainerRuntime {
  if (which('docker')) return { runtime: 'docker', env: {} }
  if (!which('podman')) return { runtime: null, env: {} }
  if (isWin) return { runtime: 'podman', env: { KIND_EXPERIMENTAL_PROVIDER: 'podman' } }
  mkdirSync(shimDir, { recursive: true })
  const shim = join(shimDir, 'docker')
  writeFileSync(shim, DOCKER_SHIM)
  chmodSync(shim, 0o755)
  return { runtime: 'podman', env: { PATH: shimDir + delimiter + PATH, KIND_EXPERIMENTAL_PROVIDER: 'podman' } }
}

const sessions = new Map<string, ChildProcess>()

/**
 * Runs an interactive program with piped stdio. Output goes out as raw
 * chunks, since prompts don't end in a newline.
 */
export function startSession(req: SessionRequest, onData: (data: string, stream: 'stdout' | 'stderr') => void, onExit: (status: number) => void) {
  const program = which(req.program) ?? req.program
  const child = spawn(program, req.args, { env: { ...env, TERM: 'dumb' }, windowsHide: true })
  sessions.set(req.id, child)
  child.stdout?.setEncoding('utf8').on('data', (d: string) => onData(d, 'stdout'))
  child.stderr?.setEncoding('utf8').on('data', (d: string) => onData(d, 'stderr'))
  child.stdin?.on('error', () => {})
  child.on('error', (e) => onData(`${req.program}: ${e.message}\n`, 'stderr'))
  child.on('close', (code, signal) => {
    sessions.delete(req.id)
    onExit(code ?? (signal ? 130 : 1))
  })
}

export function writeSession(id: string, data: string) {
  const stdin = sessions.get(id)?.stdin
  if (stdin && !stdin.destroyed) stdin.write(data)
}

export function interruptSession(id: string) {
  sessions.get(id)?.kill('SIGINT')
}

export function endSessionInput(id: string) {
  sessions.get(id)?.stdin?.end()
}

export function closeSession(id: string) {
  const child = sessions.get(id)
  if (child && !child.killed) child.kill()
}

/** Streams run in their own process groups, so stop them when the app quits. */
export function cancelAll() {
  for (const id of streams.keys()) cancel(id)
  for (const id of sessions.keys()) closeSession(id)
}
