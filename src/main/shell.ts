import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import DOCKER_SHIM from './docker-shim.sh?raw'
import type { CommandResult, ContainerRuntime, PipeRequest, RunRequest, SessionRequest, StreamRequest } from '../shared/api'
import {
  effectiveKubeconfig, expandHome, LOCAL_SOURCE, parseContextNames, parseDefaultDistro, parseFoundKubeconfigs, parseWslDistros, parseWslPath,
  splitKubeconfig, WSL_FIND_KUBECONFIGS, wslCommandLine, wslKubeconfigTarget, wslSource, wslSourceDistro, wslUncPath,
  type FoundKubeconfig, type KubeconfigInfo, type KubeconfigSource,
} from '../shared/kubeconfig'
import { localKubeconfigCandidates } from './discovery'

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

// MARK: WSL runtime
//
// On Windows a kubeconfig inside a WSL distro (\\wsl.localhost\<distro>\… or a
// /-rooted path) can't be used by the Windows ax.exe and kubectl.exe: its exec
// plugins and absolute paths only resolve in Linux. So when the chosen
// kubeconfig points into WSL, every ax, kubectl and sh step runs through
// `wsl.exe -d <distro> --exec /bin/sh -lc` with KUBECONFIG exported there.

/** Set when the chosen kubeconfig lives in WSL; null means "run natively". */
let wsl: { distro: string; linuxPaths: string[] } | null = null

const WSL_EXE = isWin ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe') : 'wsl.exe'
/** wsl.exe prints UTF-16 unless told otherwise. */
const wslEnv = { ...process.env, WSL_UTF8: '1' }

function wslExec(args: string[], timeout = 15000): string {
  return execFileSync(WSL_EXE, args, { timeout, encoding: 'utf8', env: wslEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

export function wslAvailable(): boolean {
  return isWin && existsSync(WSL_EXE)
}

let defaultDistroCache: string | null | undefined
/** The distro `wsl.exe` runs without `-d`, or '' when WSL isn't installed. */
export function wslDefaultDistro(): string {
  if (defaultDistroCache !== undefined) return defaultDistroCache ?? ''
  try {
    defaultDistroCache = parseDefaultDistro(wslExec(['-l', '-v'])) ?? parseWslDistros(wslExec(['-l', '-q']))[0] ?? null
  } catch {
    defaultDistroCache = null
  }
  return defaultDistroCache ?? ''
}

export function wslDistros(): string[] {
  if (!wslAvailable()) return []
  try {
    return parseWslDistros(wslExec(['-l', '-q']))
  } catch {
    return []
  }
}

/** The arguments that run a sh script inside a distro. `--exec` skips the WSL shell, so no second round of quoting. */
function wslArgs(distro: string, script: string): string[] {
  return ['-d', distro, '--exec', '/bin/sh', '-lc', script]
}

/** Kubeconfig files found inside a distro, with the contexts each defines. Read-only; nothing is written. */
function wslKubeconfigs(distro: string): Promise<FoundKubeconfig[]> {
  return new Promise((resolve) => {
    const child = spawn(WSL_EXE, wslArgs(distro, WSL_FIND_KUBECONFIGS), { env: wslEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill(), 60000)
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.on('error', () => { clearTimeout(timer); resolve([]) })
    child.on('close', () => { clearTimeout(timer); resolve(parseFoundKubeconfigs(wslSource(distro).id, out, (p) => wslUncPath(distro, p))) })
  })
}

// MARK: Kubeconfig discovery
//
// "Find…" in the Clusters view. Every OS has the local source: $KUBECONFIG of
// the launcher, ~/.kube/*, <tmp>/kubeconfig* and kubeconfig* files under the
// home directory. Windows adds one source per WSL distro. Only file names and
// context names are read; kubectl parses the files.

/** Where kubeconfig files can be looked for on this machine. */
export function kubeconfigSources(): KubeconfigSource[] {
  return [LOCAL_SOURCE, ...wslDistros().map(wslSource)]
}

/** The contexts a file defines, through the native kubectl; [] when kubectl is absent or cannot parse the file. */
function contextsOf(kubectl: string, file: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(kubectl, ['--kubeconfig', file, 'config', 'get-contexts', '-o', 'name'], { timeout: 10000, encoding: 'utf8', env, windowsHide: true },
      (err, stdout) => resolve(err ? [] : parseContextNames(stdout)))
  })
}

async function localKubeconfigs(): Promise<FoundKubeconfig[]> {
  const kubectl = nativeWhich('kubectl')
  if (!kubectl) return []
  const files = localKubeconfigCandidates(home, tmpdir(), inheritedKubeconfig, delimiter, sep)
  const out: FoundKubeconfig[] = []
  // A few at a time: each is a kubectl process.
  for (let i = 0; i < files.length; i += 4) {
    const batch = files.slice(i, i + 4)
    const contexts = await Promise.all(batch.map((f) => contextsOf(kubectl, f)))
    batch.forEach((f, j) => contexts[j].length && out.push({ source: LOCAL_SOURCE.id, path: f, value: f, contexts: contexts[j] }))
  }
  return out
}

/** Kubeconfig files in a source ('local' or 'wsl:<distro>'), with the contexts each defines. */
export function findKubeconfigs(sourceId: string): Promise<FoundKubeconfig[]> {
  const distro = wslSourceDistro(sourceId)
  if (distro) return wslAvailable() ? wslKubeconfigs(distro) : Promise.resolve([])
  return localKubeconfigs()
}

/** Does a path exist, looking through \\wsl.localhost for Linux paths when WSL is in use? */
export function pathExists(p: string): boolean {
  const w = parseWslPath(p)
  if (w && !w.distro) {
    const distro = wsl?.distro || wslDefaultDistro()
    return isWin ? !!distro && existsSync(wslUncPath(distro, w.linuxPath)) : existsSync(p)
  }
  return existsSync(p)
}

/**
 * Points every spawned ax, kubectl and shell step at the given kubeconfig
 * file(s). The user's own kubeconfig and global context stay untouched.
 */
export function setKubeconfig(value: string): KubeconfigInfo {
  chosenKubeconfig = value.trim()
  const paths = splitKubeconfig(chosenKubeconfig, delimiter).map((p) => expandHome(p, home, sep))
  wsl = isWin && wslAvailable() ? wslKubeconfigTarget(paths, wslDefaultDistro()) : null
  const chosen = paths.join(delimiter)
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
    missing: effective.filter((p) => !pathExists(p)),
    wsl,
  }
}

function wslWhich(program: string): string | null {
  if (!wsl) return null
  try {
    const out = wslExec(wslArgs(wsl.distro, wslCommandLine({ kubeconfig: wsl.linuxPaths, commandLine: `command -v ${JSON.stringify(program)}` })))
    const p = out.trim().split('\n')[0]?.trim()
    return p || null
  } catch {
    return null
  }
}

export function which(program: string): string | null {
  return wsl ? wslWhich(program) : nativeWhich(program)
}

/** `which` on this OS, whatever the kubeconfig target. */
function nativeWhich(program: string): string | null {
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

/** What to spawn for `program args…`: the program itself, or wsl.exe wrapping it. */
function command(program: string, args: string[], opts: { cwd?: string; extra?: Record<string, string> } = {}): [string, string[]] {
  if (wsl) return [WSL_EXE, wslArgs(wsl.distro, wslCommandLine({ kubeconfig: wsl.linuxPaths, program, args, cwd: opts.cwd, extra: opts.extra }))]
  return [which(program) ?? program, args]
}

export function run(req: RunRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [program, args] = command(req.program, req.args, { cwd: req.cwd, extra: req.env })
    let child: ChildProcess
    try {
      child = spawn(program, args, { cwd: wsl ? undefined : req.cwd, env: { ...env, ...req.env }, windowsHide: true })
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
    let stdout = ''
    let stderr = ''
    let failed: number | null = null
    let left = 2
    const done = (code: number | null) => {
      if (code !== 0 && failed === null) failed = code ?? 1
      if (--left === 0) resolve({ status: failed ?? 0, stdout, stderr })
    }
    const [fromProgram, fromArgs] = command(req.program, req.from)
    const [toProgram, toArgs] = command(req.program, req.to)
    const from = spawn(fromProgram, fromArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const to = spawn(toProgram, toArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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

/** The shell used for cluster setup steps. Steps are POSIX sh; on Windows prefer Git Bash, or WSL when the kubeconfig is there. */
function shellFor(req: StreamRequest): [string, string[]] {
  if (wsl) return [WSL_EXE, wslArgs(wsl.distro, wslCommandLine({ kubeconfig: wsl.linuxPaths, commandLine: req.commandLine, cwd: req.cwd, extra: req.env }))]
  if (!isWin) return ['/bin/sh', ['-c', req.commandLine]]
  const bash = which('bash')
  return bash ? [bash, ['-lc', req.commandLine]] : ['cmd.exe', ['/d', '/s', '/c', req.commandLine]]
}

const streams = new Map<string, ChildProcess>()

export function stream(req: StreamRequest, onLine: (line: string) => void, onExit: (status: number) => void) {
  const [sh, args] = shellFor(req)
  // Its own process group on unix, so cancel reaches the whole pipeline (make, go, kind…).
  const child = spawn(sh, args, { cwd: wsl ? undefined : req.cwd, env: { ...env, ...req.env }, windowsHide: true, detached: !isWin })
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
 * user's global context. With a WSL kubeconfig the file is written into the
 * distro's /tmp (through \\wsl.localhost) and Linux paths are returned.
 */
export function kubeconfigFor(context: string): string {
  const name = `axstudio-kubeconfig-${context.replace(/[^\w.-]/g, '_')}.yaml`
  const body = `apiVersion: v1\nkind: Config\ncurrent-context: ${JSON.stringify(context)}\n`
  if (wsl) {
    writeFileSync(wslUncPath(wsl.distro, `/tmp/${name}`), body)
    return [`/tmp/${name}`, ...wsl.linuxPaths].join(':')
  }
  const file = join(tmpdir(), name)
  writeFileSync(file, body)
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
  // Inside WSL the shim dir would be a Windows path; kind's podman provider is enough there.
  if (isWin || wsl) return { runtime: 'podman', env: { KIND_EXPERIMENTAL_PROVIDER: 'podman' } }
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
  const [program, args] = command(req.program, req.args, { extra: { TERM: 'dumb' } })
  const child = spawn(program, args, { env: { ...env, TERM: 'dumb' }, windowsHide: true })
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
