// The ax-server tunnel. Pure functions, shared by the main process (which
// owns the port-forward) and the tests.
//
// `ax` reaches its server through `kubectl port-forward -n ax-system
// svc/ax-server :8080`, which it starts itself and gives up on after 5 s.
// On a slow link (WSL with tunnelled DNS, a VPN) the forward needs longer, so
// every ax call fails and the app looks hung. When AX_SERVER is set, ax uses
// that URL and starts nothing. So the app keeps one port-forward per context
// alive and exports AX_SERVER to each ax call.

export const AX_SYSTEM_NAMESPACE = 'ax-system'
export const AX_SERVER_SERVICE = 'ax-server'
export const AX_SERVER_PORT = 8080
/** How long a port-forward may take to print its local port: covers slow DNS and a cold exec plugin. */
export const TUNNEL_TIMEOUT_MS = 90_000

/** Is this program ax: `ax`, `ax.exe`, or a path that ends in one of them? */
export function isAx(program: string): boolean {
  return /(^|[\\/])ax(\.exe)?$/i.test(program.trim())
}

/** Subcommands that never talk to the server. */
const LOCAL_SUBCOMMANDS = new Set(['version', 'help', 'completion', 'tunnel', 'ctx'])

/**
 * Does `ax args…` need the server? Global flags with a value (`--context x`,
 * `-a ns`) are skipped to find the subcommand. `ax --help` and local
 * subcommands run without a tunnel; so does a call that already sets AX_SERVER.
 */
export function axNeedsServer(args: string[], extra?: Record<string, string>): boolean {
  if (extra?.AX_SERVER) return false
  const sub = axSubcommand(args)
  if (!sub) return false
  return !LOCAL_SUBCOMMANDS.has(sub)
}

/** Flags that take a value, as `--flag value`. `--flag=value` is one token and needs no entry. */
const VALUE_FLAGS = new Set(['--context', '-a', '--atespace', '--namespace', '-n', '--kubeconfig', '-o', '--output'])

/** The first non-flag token, or null for `ax`, `ax --help`. */
export function axSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-h' || a === '--help') return null
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++
      continue
    }
    return a
  }
  return null
}

/** The value of `--context` or `--context=…`, or '' when the call follows the kubeconfig's current context. */
export function axContextArg(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--context') return args[i + 1] ?? ''
    if (args[i].startsWith('--context=')) return args[i].slice('--context='.length)
  }
  return ''
}

/** The kubectl arguments that forward a local port to the ax server of a context. */
export function portForwardArgs(context: string, namespace = AX_SYSTEM_NAMESPACE): string[] {
  return [...(context ? ['--context', context] : []), 'port-forward', '-n', namespace, `svc/${AX_SERVER_SERVICE}`, `:${AX_SERVER_PORT}`]
}

/** The local port from kubectl's `Forwarding from 127.0.0.1:NNNNN -> 8080`, or null until it is printed. */
export function parseForwardedPort(stdout: string): number | null {
  const m = /Forwarding from (?:127\.0\.0\.1|\[::1\]|localhost):(\d+)\s*->/.exec(stdout)
  return m ? Number(m[1]) : null
}

/** The message shown when the tunnel cannot start: one line of cause, then kubectl's own words. */
export function tunnelError(context: string, cause: string, kubectlOutput: string): string {
  const where = context ? `context ${context}` : 'the current context'
  const tail = kubectlOutput.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
  return [`ax-server tunnel (kubectl port-forward -n ${AX_SYSTEM_NAMESPACE} svc/${AX_SERVER_SERVICE}) on ${where}: ${cause}`, tail].filter(Boolean).join('\n')
}
