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
