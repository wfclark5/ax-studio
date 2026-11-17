// The file-system half of kubeconfig discovery on this computer. Pure
// node:fs, no Electron, so node:test can load it.
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { expandHome, FIND_MAX_DEPTH, FIND_MAX_FILES, isKubeconfigName, SKIP_DIRS, splitKubeconfig } from '../shared/kubeconfig.ts'

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name)).sort()
  } catch {
    return []
  }
}

/** `kubeconfig*` files under `root`, depth- and count-limited, skipping SKIP_DIRS and symlinks. */
export function walkKubeconfigs(root: string, found: string[] = [], depth = 0): string[] {
  if (depth > FIND_MAX_DEPTH || found.length >= FIND_MAX_FILES) return found
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    if (found.length >= FIND_MAX_FILES) break
    const p = join(root, e.name)
    if (e.isFile() && isKubeconfigName(e.name)) found.push(p)
    else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walkKubeconfigs(p, found, depth + 1)
  }
  return found
}

/**
 * Candidate files on this computer, in the order kubectl users expect:
 * $KUBECONFIG of the launcher, ~/.kube/config, the rest of ~/.kube, kubeconfig*
 * in the temp directory, then kubeconfig* files under the home directory.
 * Only existing regular files, no duplicates.
 */
export function localKubeconfigCandidates(home: string, tmp: string, inherited: string, delimiter: string, sep: string): string[] {
  const out: string[] = []
  const add = (p: string) => { if (!out.includes(p) && isFile(p)) out.push(p) }
  for (const p of splitKubeconfig(inherited, delimiter)) add(expandHome(p, home, sep))
  const kube = join(home, '.kube')
  add(join(kube, 'config'))
  for (const f of listFiles(kube)) add(f)
  for (const f of listFiles(tmp)) if (isKubeconfigName(f.slice(tmp.length + 1))) add(f)
  for (const f of walkKubeconfigs(home)) add(f)
  return out
}
