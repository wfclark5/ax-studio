import { useEffect, useRef, useState } from 'react'
import { Boxes, FileKey, Gauge, Laptop, Network, RefreshCw, Server, Settings as SettingsIcon, SquarePen, SquareTerminal, ChevronDown, Check, type LucideIcon } from 'lucide-react'
import { store, useStore, type Section } from './model/store'
import logo from './assets/axel.svg'
import { designer } from './model/designer'
import { type AXContext, comparePhase, phaseLabel, shortName } from './model/resources'
import type { TraySummary } from '@shared/api'
import { PulseDot } from './components'
import { Overview } from './views/Overview'
import { Topology } from './views/Topology'
import { Designer } from './views/Designer'
import { Clusters } from './views/Clusters'
import { TerminalPage } from './views/Terminal'
import './styles/app.css'

const SECTIONS: { id: Section; title: string; icon: LucideIcon; group: 'Overview' | 'Build' }[] = [
  { id: 'overview', title: 'Activity', icon: Gauge, group: 'Overview' },
  { id: 'topology', title: 'Map', icon: Network, group: 'Overview' },
  { id: 'designer', title: 'Deploy', icon: SquarePen, group: 'Build' },
  { id: 'terminal', title: 'Terminal', icon: SquareTerminal, group: 'Build' },
  { id: 'clusters', title: 'Clusters', icon: Boxes, group: 'Build' },
]

export function App() {
  const s = useStore()

  useEffect(() => {
    void store.start()
    return window.studio.onMenu((action) => {
      if (action.startsWith('section:')) store.setSection(action.slice(8) as Section)
      else if (action === 'refresh') void store.refresh()
      else if (action === 'settings') store.set({ settingsOpen: true })
      else if (action === 'new-design') { designer.load('blank'); store.setSection('designer') }
      else if (action === 'open-manifest') { void designer.open(store.state.settings.repoPath); store.setSection('designer') }
      else if (action === 'save-manifest') void designer.save()
      else if (action === 'apply') window.dispatchEvent(new Event('ax:apply'))
      else if (action.startsWith('tray:')) trayAction(action)
    })
  }, [])

  // Keep the menu bar icon in step with the Activity page.
  useEffect(() => {
    let sent = ''
    const update = () => {
      const summary = traySummary()
      const json = JSON.stringify(summary)
      if (json === sent) return
      sent = json
      window.studio.updateTray(summary)
    }
    update()
    const off = store.subscribe(update)
    return () => void off()
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="titlebar-drag sidebar-top" />
        <nav>
          {(['Overview', 'Build'] as const).map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-heading">{g}</div>
              {SECTIONS.filter((x) => x.group === g).map((x) => (
                <button key={x.id} className={`nav-item ${s.section === x.id ? 'on' : ''}`} onClick={() => store.setSection(x.id)}>
                  <x.icon size={15} />
                  <span>{x.title}</span>
                  {x.id === 'overview' && s.tasks.length > 0 && <span className="nav-count">{s.tasks.length}</span>}
                  {x.id === 'terminal' && s.terminalTabs.length > 0 && <span className="nav-count">{s.terminalTabs.length}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="spacer" />
        <ConnectionBadge />
      </aside>
      <main className="main">
        <Toolbar />
        {s.section !== 'terminal' && (
          <div className="content" key={s.section}>
            {s.section === 'overview' && <Overview />}
            {s.section === 'topology' && <Topology />}
            {s.section === 'designer' && <Designer />}
            {s.section === 'clusters' && <Clusters />}
          </div>
        )}
        {/* Kept mounted while sessions are open so they survive page switches. */}
        {(s.section === 'terminal' || s.terminalTabs.length > 0) && (
          <div className="content" hidden={s.section !== 'terminal'}>
            <TerminalPage />
          </div>
        )}
      </main>
      {s.settingsOpen && <SettingsModal />}
    </div>
  )
}

function traySummary(): TraySummary {
  const s = store.state
  const phases = [...new Set(s.tasks.map((t) => t.phase))].sort(comparePhase)
  const groups = phases.map((p) => ({
    phase: phaseLabel(p),
    tasks: s.tasks.filter((t) => t.phase === p).map((t) => ({
      name: t.name,
      actions: (t.phase === 'running' || t.phase === 'pending' ? ['suspend']
        : t.phase === 'suspended' || t.phase === 'failed' || t.phase === 'completed' ? ['resume'] : []) as ('resume' | 'suspend')[],
    })),
  }))
  const status = s.connectionError ? 'Not connected'
    : !s.lastRefresh ? 'Loading…'
    : groups.length === 0 ? 'No tasks'
    : groups.map((g) => `${g.tasks.length} ${g.phase.toLowerCase()}`).join(' · ')
  return {
    scope: `${s.context || 'No context'} · ${s.atespace}`,
    status,
    groups,
  }
}

/** `tray:show:<task>`, `tray:resume:<task>` and `tray:suspend:<task>` from the menu bar icon. */
function trayAction(action: string) {
  const [, verb, name] = action.split(':')
  const t = store.state.tasks.find((x) => x.name === name)
  if (!t) return
  if (verb === 'show') {
    store.set({ selectedTaskID: t.id })
    store.setSection('overview')
  } else if (verb === 'resume') void store.resume(t)
  else if (verb === 'suspend') void store.suspend(t)
}

const contextIcon = (c?: AXContext) => (c?.name === 'local' ? Laptop : Server)

/** Opens the file dialog and, if a file was picked, switches ax and kubectl to it. */
async function pickKubeconfig() {
  const picked = await window.studio.pickKubeconfig(store.state.settings.kubeconfig)
  if (picked !== null) await store.useKubeconfig(picked)
}

function Toolbar() {
  const s = useStore()
  const current = store.currentContext
  const Icon = contextIcon(current)
  const [atespace, setAtespace] = useState(s.atespace)
  useEffect(() => setAtespace(s.atespace), [s.atespace])

  return (
    <header className="toolbar titlebar-drag">
      <div className="toolbar-title"><img src={logo} alt="" className="toolbar-logo" />AX Studio</div>
      <div className="spacer" />
      <div className="no-drag row">
        <Dropdown
          label={<><Icon size={14} />{current ? shortName(current.name) : 'Context'}</>}
          title="Where ax sends commands. Switching here does not change your global ax config."
        >
          {(close) => (
            <>
              {s.contexts.map((c) => {
                const CI = contextIcon(c)
                return (
                  <button key={c.name} className="menu-item" onClick={() => { store.setScope({ context: c.name }); close() }}>
                    <span className="menu-check">{c.name === s.context && <Check size={13} />}</span>
                    <CI size={13} />
                    <span className="col">
                      <span>{shortName(c.name)}{c.isCurrent && <span className="faint"> · default</span>}</span>
                      {c.description && <span className="caption faint">{c.description}</span>}
                    </span>
                  </button>
                )
              })}
              {s.axConfig && (
                <>
                  <div className="menu-sep" />
                  <button className="menu-item" disabled={current?.isCurrent ?? true}
                    onClick={() => { void store.makeDefault(s.context); close() }}>
                    <span className="menu-check" />Make Default for ax CLI
                  </button>
                </>
              )}
              <div className="menu-sep" />
              <button className="menu-item" title="Read contexts from another kubeconfig file. Your own kubeconfig does not change."
                onClick={() => { close(); void pickKubeconfig() }}>
                <span className="menu-check" /><FileKey size={13} />
                <span className="col">
                  <span>Choose kubeconfig file…</span>
                  {s.kubeconfig && <span className="caption faint mono ellipsis" style={{ maxWidth: 320 }}>{s.kubeconfig.effective.join(' · ')}</span>}
                </span>
              </button>
              {s.settings.kubeconfig && (
                <button className="menu-item" onClick={() => { close(); void store.useKubeconfig('') }}>
                  <span className="menu-check" />Use default kubeconfig
                </button>
              )}
            </>
          )}
        </Dropdown>
        <input
          className="input"
          style={{ width: 110 }}
          value={atespace}
          title="Atespace scope"
          placeholder="atespace"
          onChange={(e) => setAtespace(e.target.value)}
          onBlur={() => atespace !== s.atespace && store.setScope({ atespace: atespace || 'default' })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <button className="btn icon" title="Refresh (⌘R)" onClick={() => void store.refresh()}>
          <RefreshCw size={14} className={s.isRefreshing ? 'spin' : ''} />
        </button>
        <button className="btn icon" title="Settings" onClick={() => store.set({ settingsOpen: true })}>
          <SettingsIcon size={14} />
        </button>
      </div>
    </header>
  )
}

export function Dropdown({ label, title, children }: {
  label: React.ReactNode
  title?: string
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="dropdown" ref={ref}>
      <button className="btn" title={title} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={12} className="faint" />
      </button>
      {open && <div className="menu card fade-in">{children(() => setOpen(false))}</div>}
    </div>
  )
}

function ConnectionBadge() {
  const s = useStore()
  const color = s.connectionError ? 'var(--red)' : s.lastRefresh ? 'var(--green)' : 'var(--orange)'
  const status = s.connectionError ?? (s.lastRefresh ? `updated ${new Date(s.lastRefresh).toLocaleTimeString()}` : 'connecting…')
  return (
    <div className="conn" title={s.connectionError ?? s.axVersion ?? 'Connected'}>
      <PulseDot color={color} on={!s.connectionError && !!s.lastRefresh} />
      <div className="col" style={{ minWidth: 0 }}>
        <strong className="ellipsis">{s.context ? shortName(s.context) : 'connecting…'}</strong>
        <span className="caption muted clamp2">{status}</span>
      </div>
    </div>
  )
}

function SettingsModal() {
  const s = useStore()
  const [axPath, setAxPath] = useState(s.settings.axPath)
  const [repoPath, setRepoPath] = useState(s.settings.repoPath)
  const [interval, setIntervalValue] = useState(s.settings.refreshInterval)
  const [kubeconfig, setKubeconfig] = useState(s.settings.kubeconfig)
  const [resolved, setResolved] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const t = setTimeout(() => void window.studio.which(axPath).then(setResolved), 200)
    return () => clearTimeout(t)
  }, [axPath])
  const close = () => store.set({ settingsOpen: false })
  const save = () => {
    const axChanged = axPath !== s.settings.axPath
    const kubeChanged = kubeconfig.trim() !== s.settings.kubeconfig
    store.updateSettings({ axPath, repoPath, refreshInterval: interval })
    close()
    if (kubeChanged) void store.useKubeconfig(kubeconfig.trim())
    else if (axChanged) void store.loadContexts().then(() => store.refresh())
  }
  const browse = async () => {
    const picked = await window.studio.pickKubeconfig(kubeconfig)
    if (picked !== null) setKubeconfig(picked)
  }
  const info = s.kubeconfig
  // What the unsaved field would resolve to: the field itself, else the launch default.
  const effective = kubeconfig.trim() ? kubeconfig.trim() : info ? (info.inherited || info.defaultPath) : ''
  const missing = info && !kubeconfig.trim() ? info.missing : []
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal card fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <div className="form-grid">
          <label>ax binary</label>
          <div className="col" style={{ gap: 4 }}>
            <input className="input mono" value={axPath} onChange={(e) => setAxPath(e.target.value)} />
            <span className="caption faint mono">{resolved === undefined ? '…' : resolved ?? 'not found on PATH'}</span>
          </div>
          <label>AX repository</label>
          <input className="input mono" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
          <label>Kubeconfig</label>
          <div className="col" style={{ gap: 4 }}>
            <div className="row">
              <input className="input mono" style={{ flex: 1 }} value={kubeconfig} placeholder={info ? (info.inherited || info.defaultPath) : '~/.kube/config'}
                title="One or more kubeconfig files, joined by the path separator. Empty uses KUBECONFIG from the launcher, else ~/.kube/config."
                onChange={(e) => setKubeconfig(e.target.value)} />
              <button className="btn" onClick={() => void browse()}>Browse…</button>
            </div>
            <span className={`caption mono ${missing.length ? '' : 'faint'}`} style={missing.length ? { color: 'var(--red)' } : undefined}>
              {missing.length ? `not found: ${missing.join(', ')}` : effective}
              {!kubeconfig.trim() && info?.inherited ? ' (from the launcher)' : ''}
            </span>
          </div>
          <label>Refresh</label>
          <div className="row">
            <input type="range" min={2} max={30} step={1} value={interval} onChange={(e) => setIntervalValue(+e.target.value)} style={{ flex: 1 }} />
            <span className="mono" style={{ width: 32, textAlign: 'right' }}>{interval}s</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
          <span className="caption faint" style={{ marginRight: 'auto' }}>{s.axVersion?.split('\n')[0]}</span>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
