import { useEffect, useState, type CSSProperties } from 'react'
import {
  Boxes, Check, Circle, CircleCheck, Copy, CircleDashed, CircleX, Cpu, ExternalLink, FileKey2, FolderOpen, Layers3, Loader, Play, Plus,
  RefreshCw, Search, Server, Square, SquareTerminal, Terminal, Trash2, TriangleAlert, Wrench, X, type LucideIcon,
} from 'lucide-react'
import type { FoundKubeconfig, KubeconfigSource } from '@shared/api'
import { clusters, useClusters, STAGES, type Cluster, type Operation, type Replicas } from '../model/clusters'
import { store, useStore } from '../model/store'
import { Chip, Empty, LogConsole, PageHeader } from '../components'
import '../styles/console.css'
import '../styles/clusters.css'

type Health = 'ok' | 'warn' | 'fail' | 'none'

const HEALTH: Record<Health, { icon: LucideIcon; color: string }> = {
  ok: { icon: CircleCheck, color: 'var(--green)' },
  warn: { icon: CircleDashed, color: 'var(--warn)' },
  fail: { icon: CircleX, color: 'var(--red)' },
  none: { icon: Circle, color: 'var(--text-3)' },
}

const full = (r: Replicas) => !!r && r.total > 0 && r.ready >= r.total

export function Clusters() {
  const c = useClusters()
  const s = useStore()
  // Tools, runtime and clusters are read again whenever the kubeconfig changes:
  // a WSL kubeconfig moves every command into the distro.
  useEffect(() => void clusters.init(), [s.kubeconfig])
  const running = c.op?.status === 'running'
  const problems = clusters.problems
  const [selected, setSelected] = useState<string | null>(new URLSearchParams(location.search).get('cluster'))
  const [outputOpen, setOutputOpen] = useState(false)
  useEffect(() => { if (running) setOutputOpen(true) }, [running])

  return (
    <div className="clusters">
      <div className={`clusters-top ${outputOpen ? '' : 'full'}`}>
        <PageHeader title="Clusters" subtitle="Local AX clusters on kind: Kubernetes, then Agent Substrate, then the AX control plane.">
          {running && <button className="btn" onClick={() => clusters.cancel()}><Square size={12} />Stop</button>}
          <button className="btn" onClick={() => void clusters.refresh()} disabled={c.loading} title="Refresh">
            <RefreshCw size={13} className={c.loading ? 'spin' : ''} />Refresh
          </button>
        </PageHeader>

        <KubeconfigCard />

        {problems.map((p) => (
          <div key={p} className="row problem-line"><TriangleAlert size={14} />{p}</div>
        ))}

        <div className="clusters-layout">
          <div className="cluster-grid">
            {c.clusters.map((cl) => (
              <ClusterCard key={cl.name} cluster={cl} selected={selected === cl.name}
                onSelect={() => setSelected(selected === cl.name ? null : cl.name)} />
            ))}
            {c.loaded && c.clusters.length === 0 && problems.length === 0 && (
              <div className="card cluster-empty">
                <Empty icon={Boxes} title="No kind clusters yet">Create one on the right; it takes about ten minutes the first time.</Empty>
              </div>
            )}
          </div>
          <NewClusterForm />
        </div>

        {c.op && <OperationBar op={c.op} />}
      </div>
      <LogConsole
        lines={c.log}
        onClear={() => clusters.set({ log: [] })}
        clearDisabled={running}
        empty="Create a cluster, or install AX on an existing one."
        open={outputOpen}
        onToggle={() => setOutputOpen(!outputOpen)}
      />
    </div>
  )
}

/**
 * Which kubeconfig file(s) AX Studio reads, and how to change them: a file
 * dialog, a search of the usual places (this computer, or a WSL distro on
 * Windows), or the launch default. With a WSL file, ax and kubectl run inside
 * that distro.
 */
function KubeconfigCard() {
  const s = useStore()
  const info = s.kubeconfig
  const [findOpen, setFindOpen] = useState(false)
  const chosen = s.settings.kubeconfig.trim()
  const source = chosen ? 'chosen in Studio' : info?.inherited ? 'KUBECONFIG from the launcher' : 'kubectl default'
  const contexts = s.contexts.map((c) => c.name)

  const browse = async () => {
    const picked = await window.studio.pickKubeconfig(s.settings.kubeconfig)
    if (picked !== null) await store.useKubeconfig(picked)
  }

  return (
    <div className="card kubeconfig-card">
      <div className="row kubeconfig-head">
        <FileKey2 size={15} />
        <span className="kubeconfig-title">Kubeconfig</span>
        <span className="faint">{source}</span>
        {info?.wsl && <Chip icon={Terminal} title={`ax and kubectl run inside WSL distro ${info.wsl.distro}`}>WSL · {info.wsl.distro}</Chip>}
        <div className="spacer" />
        <button className="btn small" onClick={() => void browse()} title="Pick one or more kubeconfig files. Your own kubeconfig does not change.">
          <FolderOpen size={12} />Browse…
        </button>
        <button className={`btn small ${findOpen ? 'active' : ''}`} onClick={() => setFindOpen(!findOpen)}
          title="List the kubeconfig files in the usual places (~/.kube, $KUBECONFIG, kubeconfig* files; WSL distros on Windows) and use one of them">
          <Search size={12} />Find…
        </button>
        {chosen && (
          <button className="btn small ghost" onClick={() => void store.useKubeconfig('')} title="Back to KUBECONFIG from the launcher, else ~/.kube/config">
            <X size={12} />Use default
          </button>
        )}
      </div>
      <div className="kubeconfig-files">
        {(info?.effective ?? []).map((f) => {
          const missing = info?.missing.includes(f)
          return (
            <div key={f} className={`row kubeconfig-file ${missing ? 'missing' : ''}`}>
              {missing ? <CircleX size={13} color="var(--red)" /> : <CircleCheck size={13} color="var(--green)" />}
              <span className="mono selectable ellipsis" title={f}>{f}</span>
              {missing && <span className="faint">not found</span>}
              {chosen && info && info.effective.length > 1 && (
                <button className="btn small icon ghost" title="Remove this file from the list"
                  onClick={() => void store.useKubeconfig(info.effective.filter((x) => x !== f).join(s.pathSeparator))}>
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="row kubeconfig-contexts">
        <span className="faint">{contexts.length ? `${contexts.length} context${contexts.length === 1 ? '' : 's'}:` : s.connectionError ? 'No contexts read.' : 'No contexts.'}</span>
        {contexts.map((c) => (
          <button key={c} className={`chip ctx-chip ${c === s.context ? 'active' : ''}`} title={c === s.context ? 'In use' : `Switch AX Studio to ${c}`}
            onClick={() => c !== s.context && store.setScope({ context: c })}>{c}</button>
        ))}
      </div>
      {s.connectionError && <div className="row problem-line selectable" style={{ marginTop: 0 }}><TriangleAlert size={13} />{s.connectionError}</div>}
      {findOpen && <FindPicker onClose={() => setFindOpen(false)} />}
    </div>
  )
}

/**
 * Lists the kubeconfig files found in one source: this computer, or a WSL
 * distro on Windows. Use replaces the list, Add appends.
 */
function FindPicker({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const [sources, setSources] = useState<KubeconfigSource[] | null>(null)
  const [source, setSource] = useState('')
  const [files, setFiles] = useState<FoundKubeconfig[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.studio.kubeconfigSources().then((list) => {
      if (!live) return
      setSources(list)
      // Start in the source of the kubeconfig in use: the WSL distro when it is one.
      const wsl = s.kubeconfig?.wsl?.distro
      setSource((cur) => cur || (wsl && list.find((x) => x.id === `wsl:${wsl}`)?.id) || list[0]?.id || '')
    })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!source) return
    let live = true
    setFiles(null)
    void window.studio.findKubeconfigs(source).then((f) => live && setFiles(f))
    return () => { live = false }
  }, [source])

  const label = sources?.find((x) => x.id === source)?.label ?? source
  const isWsl = source.startsWith('wsl:')
  const current = s.kubeconfig?.effective ?? []
  const apply = async (paths: string[]) => {
    setBusy(true)
    try {
      await store.useKubeconfig(paths.join(s.pathSeparator))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kc-picker">
      <div className="row kc-picker-head">
        <span>Kubeconfig files found</span>
        {sources && sources.length > 1 && (
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        )}
        {sources && sources.length === 1 && <span className="faint">{label}</span>}
        <div className="spacer" />
        <button className="btn small icon ghost" onClick={onClose} title="Close"><X size={12} /></button>
      </div>
      <div className="caption">
        Looks in <span className="mono">~/.kube</span>, <span className="mono">$KUBECONFIG</span>, <span className="mono">kubeconfig*</span> files in the
        temp directory and under your home. Only file names and context names are read.
        {isWsl && <> With a WSL file, ax and kubectl run inside the distro, so exec plugins such as <span className="mono">aws eks get-token</span> work.</>}
      </div>
      {source && files === null && <div className="row faint"><Loader size={13} className="spin" />Looking in {label}…</div>}
      {files && files.length === 0 && (
        <div className="row faint">No kubeconfig file with a context found in {label}{isWsl ? '' : ', or kubectl is not on PATH'}.</div>
      )}
      {files && files.map((f) => {
        const inUse = current.includes(f.value)
        return (
          <div key={f.value} className="kc-file">
            <div className="row">
              <span className="mono selectable ellipsis" title={f.value}>{f.path}</span>
              <div className="spacer" />
              {inUse ? <span className="faint">in use</span> : (
                <>
                  <button className="btn small primary" disabled={busy} onClick={() => void apply([f.value])} title="Use only this file">Use</button>
                  <button className="btn small" disabled={busy} onClick={() => void apply([...current, f.value])} title="Add it after the files in use">Add</button>
                </>
              )}
            </div>
            <div className="row kc-file-ctx">
              {f.contexts.map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function layers(c: Cluster): { id: string; icon: LucideIcon; title: string; detail: string; health: Health }[] {
  const kind: Health = !c.reachable ? 'fail' : full(c.nodes) ? 'ok' : 'warn'
  const substrate: Health = !c.reachable || !c.substrate ? 'none' : full(c.substrate) ? 'ok' : 'warn'
  const ax: Health = !c.reachable || !c.ax ? 'none' : full(c.ax) && (!c.workers || full(c.workers)) ? 'ok' : 'warn'
  return [
    {
      id: 'ax', icon: Server, title: 'AX', health: ax,
      detail: !c.ax ? 'Not installed'
        : `ax-server ${c.ax.ready}/${c.ax.total}${c.workers ? ` · ${c.workers.ready}/${c.workers.total} gVisor workers` : ''}`,
    },
    {
      id: 'substrate', icon: Layers3, title: 'Agent Substrate', health: substrate,
      detail: !c.substrate ? 'Not installed'
        : `ate-api-server ${c.substrate.ready}/${c.substrate.total}${c.substrateCommit ? ` · ${c.substrateCommit.slice(0, 7)}` : ''}`,
    },
    {
      id: 'kind', icon: Cpu, title: 'Kind', health: kind,
      detail: !c.reachable ? 'Unreachable; is the container runtime running?'
        : `${c.nodes?.ready ?? 0}/${c.nodes?.total ?? 0} nodes Ready${c.version ? ` · Kubernetes ${c.version.replace(/^v/, '')}` : ''}`,
    },
  ]
}

function ClusterCard({ cluster: cl, selected, onSelect }: { cluster: Cluster; selected: boolean; onSelect: () => void }) {
  const c = useClusters()
  const s = useStore()
  const busy = c.op?.status === 'running'
  const mine = busy && c.op?.cluster === cl.name
  const rows = layers(cl)
  const axReady = rows[0].health === 'ok'
  const current = s.context === cl.context
  const buildBlocked = clusters.buildProblems.length > 0

  const install = () => {
    const reinstall = !!cl.ax
    const msg = reinstall
      ? `Reinstall AX on ${cl.name}?\n\nThis rebuilds AX and recreates its Postgres, so existing tasks and workspaces are deleted. Substrate is reinstalled if its version differs from the one AX is built against.`
      : `Install AX on ${cl.name}?\n\nThis installs Agent Substrate${cl.substrate ? ' (reinstalling it if its version differs from the one AX is built against)' : ''}, a gVisor worker pool and the AX control plane.`
    if (confirm(msg)) void clusters.install(cl.name)
  }
  const remove = () => {
    if (confirm(`Delete kind cluster ${cl.name}?\n\nThe cluster and everything in it are removed, and kind-${cl.name} is dropped from your kubeconfig.`)) {
      void clusters.remove(cl.name)
    }
  }

  return (
    <div className={`card cluster-card ${mine ? 'busy' : ''} ${current || selected ? 'highlight' : ''}`}>
      <div className="row cluster-head">
        <div className="cluster-icon"><Boxes size={16} /></div>
        <div className="cluster-name">
          <div className="cluster-title">{cl.name}</div>
          <div className="faint mono cluster-ctx">{cl.context}{current && ' · in use'}</div>
        </div>
        <div className="spacer" />
        <Overall rows={rows} />
        <button className={`btn term-btn ${selected ? 'active' : ''}`} onClick={onSelect}
          title={selected ? 'Hide terminal commands' : 'Use this cluster from a terminal'}>
          <SquareTerminal size={14} />Terminal
        </button>
      </div>

      <div className="layer-stack">
        {rows.map((r) => {
          const h = HEALTH[r.health]
          return (
            <div key={r.id} className={`layer ${r.health}`} style={{ '--c': h.color } as CSSProperties}>
              <r.icon size={14} className="layer-icon" />
              <div className="layer-text">
                <div className="layer-title">{r.title}</div>
                <div className="layer-detail">{r.detail}</div>
              </div>
              <h.icon size={14} color={h.color} />
            </div>
          )
        })}
      </div>

      {selected && <ConnectCommands cluster={cl} />}

      <div className="row cluster-actions">
        {axReady && (
          <button className="btn small primary" disabled={busy || current} onClick={() => void clusters.open(cl)}
            title={cl.inKubeconfig ? `Switch AX Studio to ${cl.context}` : `Add ${cl.context} to your kubeconfig and switch AX Studio to it`}>
            <ExternalLink size={12} />{current ? 'Open' : 'Open in Studio'}
          </button>
        )}
        {cl.reachable && (
          <button className="btn small" disabled={busy || buildBlocked} onClick={install}
            title={buildBlocked ? clusters.buildProblems.join(' ') : undefined}>
            {cl.ax ? <Wrench size={12} /> : <Play size={12} />}{cl.ax ? 'Reinstall AX' : 'Install AX'}
          </button>
        )}
        <div className="spacer" />
        <button className="btn small ghost danger" disabled={busy} onClick={remove} title={`Delete ${cl.name}`}>
          <Trash2 size={12} />Delete
        </button>
      </div>
      {mine && <div className="step-progress" />}
    </div>
  )
}

/** Shell commands for using the cluster from a terminal. */
function ConnectCommands({ cluster: cl }: { cluster: Cluster }) {
  const c = useClusters()
  const s = useStore()
  const provider = c.runtime?.runtime === 'podman' ? 'KIND_EXPERIMENTAL_PROVIDER=podman ' : ''
  const commands = [
    { note: `Import ${cl.context} into your kubeconfig (adds or refreshes it and makes it current)`, cmd: `${provider}kind export kubeconfig --name ${cl.name}` },
    ...(cl.inKubeconfig ? [{ note: 'Already imported: switch kubectl to it', cmd: `kubectl config use-context ${cl.context}` }] : []),
    ...(cl.ax && s.axConfig ? [{ note: 'Point ax at this cluster', cmd: `ax config use-context ${cl.context}` }] : []),
  ]
  return (
    <div className="connect">
      {commands.map((x) => <CommandLine key={x.cmd} note={x.note} cmd={x.cmd} />)}
    </div>
  )
}

function CommandLine({ note, cmd }: { note: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="connect-item">
      <div className="connect-note">{note}</div>
      <div className="row connect-cmd">
        <code className="selectable">{cmd}</code>
        <button className="btn small icon ghost" onClick={copy} title="Copy">
          {copied ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  )
}

function Overall({ rows }: { rows: ReturnType<typeof layers> }) {
  const [ax, substrate, kind] = rows.map((r) => r.health)
  const v = kind === 'fail' ? { h: 'fail' as Health, label: 'Unreachable' }
    : ax === 'ok' && substrate === 'ok' && kind === 'ok' ? { h: 'ok' as Health, label: 'Ready' }
    : rows.some((r) => r.health === 'warn') ? { h: 'warn' as Health, label: 'Starting' }
    : substrate === 'none' ? { h: 'none' as Health, label: 'Kubernetes only' }
    : { h: 'none' as Health, label: 'No AX' }
  const h = HEALTH[v.h]
  return (
    <span className="badge" style={{ '--c': h.color } as CSSProperties}>
      <h.icon size={12} />{v.label}
    </span>
  )
}

function NewClusterForm() {
  const c = useClusters()
  const f = c.form
  const busy = c.op?.status === 'running'
  const nameProblem = clusters.nameProblem(f.name)
  const blockers = [...clusters.problems, ...clusters.buildProblems]
  const engine = c.runtime?.runtime

  return (
    <div className="card new-cluster">
      <div className="row new-cluster-head">
        <Plus size={15} />
        <span>New cluster</span>
      </div>
      <label className="form-row">
        <span>Name</span>
        <input className={`input mono ${f.name && nameProblem ? 'invalid' : ''}`} value={f.name} spellCheck={false}
          onChange={(e) => clusters.setForm({ name: e.target.value.trim().toLowerCase() })} placeholder="ax-dev" />
      </label>
      <label className="form-row">
        <span>Workers</span>
        <input className="input" type="number" min={1} max={8} value={f.workers}
          onChange={(e) => clusters.setForm({ workers: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
      </label>
      <label className="form-row">
        <span>Substrate</span>
        <input className="input mono" value={f.substrateRef} spellCheck={false} placeholder="version in AX's go.mod"
          onChange={(e) => clusters.setForm({ substrateRef: e.target.value })} />
      </label>
      <div className="caption new-cluster-note">
        Runs <span className="mono">hack/setup-e2e-kind.sh</span> from your AX repo with a local registry on localhost:5001
        {engine ? ` and ${engine}` : ''}. The cluster is added to your kubeconfig as <span className="mono">kind-{f.name || 'name'}</span>;
        your current context stays as it is.
      </div>
      {f.name && nameProblem && <div className="row problem-line"><TriangleAlert size={13} />{nameProblem}</div>}
      {clusters.buildProblems.map((p) => <div key={p} className="row problem-line"><TriangleAlert size={13} />{p}</div>)}
      {clusters.warnings.map((p) => <div key={p} className="row problem-line selectable"><TriangleAlert size={13} />{p}</div>)}
      <button className="btn primary" disabled={busy || !!nameProblem || blockers.length > 0} onClick={() => void clusters.create()}>
        <Play size={13} fill="currentColor" />Create cluster
      </button>
    </div>
  )
}

function OperationBar({ op }: { op: Operation }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (op.status !== 'running') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [op.status])
  const secs = Math.round(((op.finished ?? Date.now()) - op.started) / 1000)
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
  const verb = { create: 'Creating', install: 'Installing AX on', delete: 'Deleting', kubeconfig: 'Adding to kubeconfig:' }[op.kind]
  const done = { create: 'Created', install: 'Installed AX on', delete: 'Deleted', kubeconfig: 'Added to kubeconfig:' }[op.kind]
  const title = op.status === 'running' ? `${verb} ${op.cluster}` : op.status === 'ok' ? `${done} ${op.cluster}` : `${verb} ${op.cluster} failed`
  const currentIndex = STAGES.findIndex((s) => s.id === op.stage)
  const StatusIcon = op.status === 'running' ? Loader : op.status === 'ok' ? CircleCheck : CircleX
  const statusColor = op.status === 'running' ? 'var(--accent)' : op.status === 'ok' ? 'var(--green)' : 'var(--red)'

  return (
    <div className="card op-bar">
      <div className="row op-head">
        <StatusIcon size={15} color={statusColor} className={op.status === 'running' ? 'spin' : ''} />
        <span className="op-title">{title}</span>
        <span className="faint num">{elapsed}{op.status === 'failed' && op.exit !== undefined ? ` · exit ${op.exit}` : ''}</span>
        <div className="spacer" />
        {op.status !== 'running' && <button className="btn small ghost" onClick={() => clusters.set({ op: null })}>Dismiss</button>}
      </div>
      {op.stage && (
        <div className="op-stages">
          {STAGES.map((s, i) => {
            const state = op.status === 'ok' || i < currentIndex ? 'ok'
              : i > currentIndex ? 'idle'
              : op.status === 'failed' ? 'failed' : 'running'
            const Icon = state === 'ok' ? CircleCheck : state === 'failed' ? CircleX : state === 'running' ? Loader : Circle
            return (
              <div key={s.id} className={`op-stage ${state}`}>
                <Icon size={13} className={state === 'running' ? 'spin' : ''} />
                <span>{s.title}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
