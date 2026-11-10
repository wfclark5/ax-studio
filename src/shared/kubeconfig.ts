// Which kubeconfig files ax and kubectl read. Pure functions, shared by the
// main process (which sets the environment) and the renderer (which shows it).

/** Where the kubeconfig in use comes from. */
export interface KubeconfigInfo {
  /** The value picked in Settings; '' means "not set". */
  chosen: string
  /** KUBECONFIG as the app was launched, e.g. from a launcher script; '' if unset. */
  inherited: string
  /** ~/.kube/config */
  defaultPath: string
  /** The files kubectl reads, in order, with `~` expanded. */
  effective: string[]
  /** Those of `effective` that do not exist. */
  missing: string[]
  /** Set when the files live in a WSL distro: ax and kubectl then run inside it. */
  wsl: { distro: string; linuxPaths: string[] } | null
}

/** Splits a KUBECONFIG value into paths: trimmed, non-empty, first occurrence wins. */
export function splitKubeconfig(value: string, delimiter: string): string[] {
  const out: string[] = []
  for (const raw of value.split(delimiter)) {
    const p = raw.trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** `~` and `~/x` become absolute; anything else is returned as is. */
export function expandHome(p: string, home: string, sep: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return home + sep + p.slice(2)
  return p
}

/**
 * The kubeconfig files in effect: the chosen value if set, else the inherited
 * KUBECONFIG, else ~/.kube/config. Mirrors kubectl's own lookup.
 */
export function effectiveKubeconfig(chosen: string, inherited: string, home: string, delimiter: string, sep: string): string[] {
  const value = chosen.trim() || inherited.trim()
  const paths = value ? splitKubeconfig(value, delimiter) : [defaultKubeconfig(home, sep)]
  return paths.map((p) => expandHome(p, home, sep))
}

export function defaultKubeconfig(home: string, sep: string): string {
  return [home, '.kube', 'config'].join(sep)
}

// MARK: WSL paths
//
// On Windows, a kubeconfig that lives in a WSL distro is only usable from
// inside that distro: its exec plugins (aws, gke-gcloud-auth-plugin) and its
// absolute /home paths are Linux-only. These helpers decide when a chosen
// kubeconfig points into WSL and translate paths both ways.

/** A kubeconfig path inside a WSL distro. `distro` is '' for a bare Linux path (the default distro). */
export interface WslPath {
  distro: string
  /** Absolute Linux path, e.g. /home/u/.kube/config */
  linuxPath: string
}

const UNC_RE = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]+([^\\/]+)([\\/].*)?$/i

/**
 * Recognises `\\wsl.localhost\<distro>\…`, `\\wsl$\<distro>\…` (either slash
 * direction) and a /-rooted Linux path. Windows drive paths and `~` return null.
 */
export function parseWslPath(p: string): WslPath | null {
  const s = p.trim()
  const m = UNC_RE.exec(s)
  if (m) {
    const rest = (m[2] ?? '/').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    return { distro: m[1], linuxPath: rest || '/' }
  }
  if (/^\/(?!\/)/.test(s)) return { distro: '', linuxPath: s }
  return null
}

/** `C:\Users\u\x` → `/mnt/c/Users/u/x`; anything else is returned as is. */
export function windowsToWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p.trim())
  if (!m) return p
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/** The UNC path Windows uses to read a file inside a distro. */
export function wslUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

/**
 * The kubeconfig files to run through WSL, or null when none of them is in a
 * distro. The first WSL path names the distro; the other files are given as
 * Linux paths (Windows drive paths become /mnt/<drive>/…). `fallbackDistro`
 * stands in for bare Linux paths.
 */
export function wslKubeconfigTarget(paths: string[], fallbackDistro: string): { distro: string; linuxPaths: string[] } | null {
  const parsed = paths.map((p) => parseWslPath(p))
  const first = parsed.find((w) => w !== null)
  if (!first) return null
  const distro = parsed.find((w) => w?.distro)?.distro || fallbackDistro
  const linuxPaths = paths.map((p, i) => parsed[i]?.linuxPath ?? windowsToWslPath(p))
  return { distro, linuxPaths }
}

/** POSIX single-quote. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface WslCommand {
  kubeconfig: string[]
  program?: string
  args?: string[]
  /** A whole POSIX sh script, used instead of program/args. */
  commandLine?: string
  cwd?: string
  /** Extra variables to export; PATH and KUBECONFIG are ignored. */
  extra?: Record<string, string>
}

/**
 * The `sh -lc` script that runs `program args…` inside WSL with KUBECONFIG set.
 * `-l` loads the user's profile (nvm, go, aws…); the usual user bin dirs are
 * prepended in case the profile doesn't. PATH entries from the caller are
 * skipped because a Windows PATH means nothing to Linux.
 */
export function wslCommandLine(cmd: WslCommand): string {
  const lines = [
    `export KUBECONFIG=${shellQuote(cmd.kubeconfig.join(':'))}`,
    'export PATH="$HOME/.local/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"',
  ]
  for (const [k, v] of Object.entries(cmd.extra ?? {})) {
    if (k === 'PATH' || k === 'KUBECONFIG' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
    lines.push(`export ${k}=${shellQuote(v)}`)
  }
  if (cmd.cwd) {
    const dir = parseWslPath(cmd.cwd)?.linuxPath ?? windowsToWslPath(cmd.cwd)
    lines.push(`cd ${shellQuote(dir)} || exit 1`)
  }
  if (cmd.commandLine !== undefined) lines.push(cmd.commandLine)
  else lines.push(['exec', ...[cmd.program ?? 'true', ...(cmd.args ?? [])].map(shellQuote)].join(' '))
  return lines.join('\n')
}

/** Output of `wsl.exe -l -q`, which may be UTF-16 read as UTF-8 (NUL between chars). */
export function parseWslDistros(stdout: string): string[] {
  return stdout.replace(/\u0000/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** Default distro from `wsl.exe -l -v`: the line marked with `*`. */
export function parseDefaultDistro(stdout: string): string | null {
  for (const l of parseWslDistros(stdout)) {
    const m = /^\*\s*(\S+)/.exec(l)
    if (m) return m[1]
  }
  return null
}

/** One kubeconfig file found inside a distro, with the contexts it defines. */
export interface WslKubeconfig {
  distro: string
  linuxPath: string
  /** What to put in the kubeconfig setting on Windows. */
  uncPath: string
  contexts: string[]
}

/** Script that prints `path<TAB>ctx1,ctx2` for each kubeconfig file in the usual places. */
export const WSL_FIND_KUBECONFIGS = [
  'export PATH="$HOME/.local/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"',
  'list() { for f in "$@"; do [ -f "$f" ] && printf "%s\\n" "$f"; done; }',
  'ifs=$IFS; IFS=:; kc=$(list $KUBECONFIG); IFS=$ifs',
  '{ printf "%s\\n" "$kc"; list "$HOME/.kube/config" "$HOME"/.kube/* /tmp/kubeconfig*;',
  '  find "$HOME" -maxdepth 7 \\( -name node_modules -o -name .git -o -name .cache -o -name .npm \\) -prune -o -type f -name "kubeconfig*" -print 2>/dev/null | head -50; } |',
  'awk "NF && !seen[\\$0]++" | while IFS= read -r f; do',
  '  ctx=$(kubectl --kubeconfig "$f" config get-contexts -o name 2>/dev/null | paste -sd, -)',
  '  printf "%s\\t%s\\n" "$f" "$ctx"',
  'done',
].join('\n')

/** Parses the output of WSL_FIND_KUBECONFIGS. Files without a context are dropped. */
export function parseWslKubeconfigs(distro: string, stdout: string): WslKubeconfig[] {
  const out: WslKubeconfig[] = []
  for (const raw of stdout.replace(/\u0000/g, '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue
    const tab = line.indexOf('\t')
    const linuxPath = (tab >= 0 ? line.slice(0, tab) : line).trim()
    if (!linuxPath.startsWith('/') || out.some((k) => k.linuxPath === linuxPath)) continue
    const contexts = tab >= 0 ? line.slice(tab + 1).split(',').map((c) => c.trim()).filter(Boolean) : []
    // No context means kubectl could not parse the file (a backup, a note…): not worth offering.
    if (contexts.length === 0) continue
    out.push({ distro, linuxPath, uncPath: wslUncPath(distro, linuxPath), contexts })
  }
  return out
}
