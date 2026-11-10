import { useSyncExternalStore } from 'react'
import type { CommandResult, KubeconfigInfo } from '@shared/api'
import {
  type AXContext, type AXModel, type AXTask, type AXWorkspace, type Phase, type TaskDetail,
  comparePhase, errorSummary, parseContexts, parseModels, parseTaskYAML, parseTasks,
  parseWorkspaceYAML, parseWorkspaces,
} from './resources'

export type Section = 'overview' | 'topology' | 'terminal' | 'designer' | 'clusters'
const SECTIONS: Section[] = ['overview', 'topology', 'designer', 'terminal', 'clusters']

export interface ActivityEntry {
  id: number
  date: number
  title: string
  detail: string
  ok: boolean
}

/** Phase counts at one refresh, for the "tasks over time" chart. */
export interface PhaseSample {
  date: number
  counts: Record<string, number>
}

export interface Settings {
  axPath: string
  repoPath: string
  refreshInterval: number
  /** KUBECONFIG value for every ax and kubectl call; '' means the launch default (KUBECONFIG, else ~/.kube/config). */
  kubeconfig: string
}

export interface State {
  section: Section
  contexts: AXContext[]
  context: string
  atespace: string
  tasks: AXTask[]
  workspaces: AXWorkspace[]
  models: AXModel[]
  details: Record<string, TaskDetail>
  selectedTaskID: string | null
  isRefreshing: boolean
  lastRefresh: number | null
  connectionError: string | null
  activity: ActivityEntry[]
  history: PhaseSample[]
  axVersion: string | null
  /** Whether this ax build has `ax config`; newer builds follow the kubectl context instead. */
  axConfig: boolean
  /** Open terminals, in tab order. */
  terminalTabs: TerminalTab[]
  /** The key of the tab shown on the Terminal page. */
  terminalActive: string | null
  settings: Settings
  settingsOpen: boolean
  os: string
  /** The KUBECONFIG list separator of the platform: ':' or ';' on Windows. */
  pathSeparator: string
  /** The kubeconfig files in effect, as the main process reports them; null until start(). */
  kubeconfig: KubeconfigInfo | null
}

/** A terminal session, fixed to the task and context it was opened for. */
export interface TerminalTab { key: string; task: AXTask; context: string; scope: string[] }

let tabCount = 0

const SETTINGS_KEY = 'ax-studio.settings'
const SECTION_KEY = 'ax-studio.section'
/** The context last picked, so a broken kube default doesn't greet every launch. */
const CONTEXT_KEY = 'ax-studio.context'

function loadSettings(): Settings {
  const defaults: Settings = { axPath: 'ax', repoPath: '~/ax', refreshInterval: 4, kubeconfig: '' }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return defaults
  }
}

const result = (r: CommandResult) => ({ ...r, ok: r.status === 0, error: errorSummary(r.stdout, r.stderr) })
export type Result = ReturnType<typeof result>

class Store {
  state: State = {
    section: [new URLSearchParams(location.search).get('section'), localStorage.getItem(SECTION_KEY)].find((x): x is Section => SECTIONS.includes(x as Section)) ?? 'overview',
    contexts: [],
    context: '',
    atespace: new URLSearchParams(location.search).get('atespace') || 'default',
    tasks: [],
    workspaces: [],
    models: [],
    details: {},
    selectedTaskID: null,
    isRefreshing: false,
    lastRefresh: null,
    connectionError: null,
    activity: [],
    history: [],
    axVersion: null,
    axConfig: true,
    terminalTabs: [],
    terminalActive: null,
    settings: loadSettings(),
    settingsOpen: false,
    os: 'darwin',
    pathSeparator: ':',
    kubeconfig: null,
  }

  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private nextID = 1
  /** `?task=` from the command line: select it once it loads. */
  private askedTask = new URLSearchParams(location.search).get('task')
  private askedTerminal = new URLSearchParams(location.search).has('terminal')

  /** Selects the `?task=` task (and opens its terminal for `?terminal=`) once it shows up. */
  private takeAskedTask(tasks: AXTask[]): Partial<State> {
    const t = this.askedTask ? tasks.find((x) => x.name === this.askedTask) : undefined
    if (!t) return {}
    this.askedTask = null
    if (!this.askedTerminal) return { selectedTaskID: t.id }
    const tab = this.newTab(t)
    return { selectedTaskID: t.id, section: 'terminal', terminalTabs: [...this.state.terminalTabs, tab], terminalActive: tab.key }
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // MARK: Derived

  get currentContext() {
    return this.state.contexts.find((c) => c.name === this.state.context)
  }
  tasksIn = (p: Phase) => this.state.tasks.filter((t) => t.phase === p)
  tasksUsing = (ws: string) => this.state.tasks.filter((t) => this.state.details[t.id]?.workspace === ws)

  // MARK: Lifecycle

  async start() {
    if (this.started) return
    this.started = true
    const info = await window.studio.platform()
    this.set({ os: info.os, pathSeparator: info.pathSeparator })
    // Before the first ax or kubectl call, so they read the chosen file.
    this.set({ kubeconfig: await window.studio.setKubeconfig(this.state.settings.kubeconfig) })
    await this.loadContexts()
    this.loop()
  }

  /**
   * Switches every ax and kubectl call to another kubeconfig file (or files,
   * joined by the platform's path separator). '' restores the launch default.
   * The context list is read again from the new file.
   */
  async useKubeconfig(value: string) {
    this.updateSettings({ kubeconfig: value })
    const kubeconfig = await window.studio.setKubeconfig(value)
    this.set({ kubeconfig, context: '', contexts: [], tasks: [], workspaces: [], models: [], details: {}, history: [], selectedTaskID: null, connectionError: null })
    await this.loadContexts()
    await this.refresh()
  }

  private loop = async () => {
    await this.refresh()
    this.timer = setTimeout(this.loop, Math.max(1.5, this.state.settings.refreshInterval) * 1000)
  }

  setSection(section: Section) {
    localStorage.setItem(SECTION_KEY, section)
    this.set({ section })
  }

  /** Opens Activity and selects the named task, now or once it shows up. */
  showTask(name: string | null) {
    this.askedTask = name
    this.askedTerminal = false
    this.set({ ...this.takeAskedTask(this.state.tasks) })
    this.setSection('overview')
  }

  updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    this.set({ settings })
  }

  setScope(patch: { context?: string; atespace?: string }) {
    if (patch.context) localStorage.setItem(CONTEXT_KEY, patch.context)
    this.set({ ...patch, tasks: [], workspaces: [], models: [], details: {}, history: [], selectedTaskID: null, connectionError: null })
    void this.refresh()
  }

  async loadContexts() {
    const v = result(await window.studio.run({ program: this.state.settings.axPath, args: ['version'] }))
    this.set({ axVersion: v.ok ? v.stdout.trim() : null })
    // Ask through the last-used context: an ax without `ax config` connects
    // first, and the kube default may be unreachable.
    const saved = localStorage.getItem(CONTEXT_KEY)
    const via = saved ? ['--context', saved] : []
    const r = result(await window.studio.run({ program: this.state.settings.axPath, args: [...via, 'config', 'get-contexts'] }))
    let contexts: AXContext[]
    if (r.ok) {
      contexts = parseContexts(r.stdout)
      this.set({ axConfig: true })
    } else if (/unknown command/i.test(r.stderr + r.stdout)) {
      // This ax has no `ax config`: it follows kubectl's contexts. It prints
      // its usage after the error, so look at all of the output.
      contexts = await kubeContexts()
      this.set({ axConfig: false })
    } else {
      // An ax without `ax config` connects before it parses the command, so an
      // unreachable cluster hides the unknown command. Still list kubectl's
      // contexts so the user can switch to one that works.
      contexts = await kubeContexts()
      this.set({ axConfig: false })
      // With contexts to pick from, refresh reports the chosen one's errors.
      if (!contexts.length) {
        this.set({ connectionError: r.error })
        return
      }
    }
    const asked = new URLSearchParams(location.search).get('context')
    const last = contexts.find((c) => c.name === saved)?.name
    this.set({ contexts, context: this.state.context || asked || last || contexts.find((c) => c.isCurrent)?.name || (this.state.axConfig ? 'local' : contexts[0]?.name ?? '') })
  }

  // MARK: Running ax

  /** Every resource command targets the chosen context without changing the user's global `ax config`. */
  get scope() {
    const a: string[] = []
    if (this.state.context) a.push('--context', this.state.context)
    a.push('-a', this.state.atespace || 'default')
    return a
  }

  async ax(args: string[], stdin?: string): Promise<Result> {
    return result(await window.studio.run({ program: this.state.settings.axPath, args: [...this.scope, ...args], stdin }))
  }

  /** Runs a mutating command, records it in the activity feed, then refreshes. */
  async perform(title: string, args: string[], stdin?: string): Promise<Result> {
    const r = await this.ax(args, stdin)
    this.log(title, r.ok ? r.stdout.trim() : r.error, r.ok)
    await this.refresh(true)
    return r
  }

  log(title: string, detail: string, ok: boolean) {
    const entry: ActivityEntry = { id: this.nextID++, date: Date.now(), title, detail, ok }
    this.set({ activity: [entry, ...this.state.activity].slice(0, 200) })
  }

  // MARK: Refresh

  async refresh(force = false) {
    if ((this.state.isRefreshing && !force) || !this.state.context) return
    this.set({ isRefreshing: true })
    try {
      const [tr, wr, mr] = await Promise.all([this.ax(['get', 'tasks']), this.ax(['get', 'workspaces']), this.ax(['get', 'models'])])
      if (!tr.ok) {
        this.set({ connectionError: tr.error })
        return
      }
      const tasks = parseTasks(tr.stdout).sort((a, b) => comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name))
      // Keep already-described workspaces so the topology doesn't flicker.
      const workspaces = wr.ok
        ? parseWorkspaces(wr.stdout).map((w) => {
            const old = this.state.workspaces.find((o) => o.id === w.id)
            return old ? { ...w, repos: old.repos, mcpServers: old.mcpServers, files: old.files } : w
          })
        : this.state.workspaces
      const counts: Record<string, number> = {}
      for (const t of tasks) counts[t.phase] = (counts[t.phase] ?? 0) + 1
      this.set({
        connectionError: null,
        tasks: same(tasks, this.state.tasks) ? this.state.tasks : tasks,
        ...this.takeAskedTask(tasks),
        workspaces,
        models: mr.ok ? parseModels(mr.stdout) : this.state.models,
        lastRefresh: Date.now(),
        history: [...this.state.history, { date: Date.now(), counts }].slice(-360),
      })
      await this.loadDetails()
    } finally {
      this.set({ isRefreshing: false })
    }
  }

  /** Reads each task and workspace so the board and graph know the links. */
  private async loadDetails() {
    const tasks = this.state.tasks
    const results = await Promise.all(tasks.map((t) => this.ax(['get', 'task', t.name])))
    const details: Record<string, TaskDetail> = {}
    tasks.forEach((t, i) => {
      const r = results[i]
      if (r.ok) details[t.id] = parseTaskYAML(r.stdout)
      else if (this.state.details[t.id]) details[t.id] = this.state.details[t.id]
    })
    const wsResults = await Promise.all(this.state.workspaces.map((w) => this.ax(['get', 'workspace', w.name])))
    const workspaces = this.state.workspaces.map((w, i) => (wsResults[i]?.ok ? parseWorkspaceYAML(wsResults[i].stdout, w) : w))
    this.set({ details, workspaces })
  }

  // MARK: Actions

  suspend = (t: AXTask) => this.perform(`Suspend ${t.name}`, ['suspend', 'task', t.name])
  resume = (t: AXTask) => this.perform(`Resume ${t.name}`, ['resume', 'task', t.name])
  remove = (kind: string, name: string) => this.perform(`Delete ${kind} ${name}`, ['delete', kind, name])
  apply = (yaml: string) => this.perform('Apply manifest', ['apply', '-f', '-'], yaml)

  async makeDefault(ctx: string) {
    if (!this.state.axConfig) return
    const r = result(await window.studio.run({ program: this.state.settings.axPath, args: ['config', 'use-context', ctx] }))
    this.log(`Use context ${ctx}`, r.ok ? 'now the default for ax' : r.error, r.ok)
    await this.loadContexts()
  }

  private newTab(t: AXTask): TerminalTab {
    return { key: `tab-${++tabCount}`, task: t, context: this.state.context, scope: this.scope }
  }

  /** Shows the task's terminal on the Terminal page, opening one if there isn't one yet. */
  openTerminal(t: AXTask) {
    const open = this.state.terminalTabs.find((x) => x.task.id === t.id && x.context === this.state.context)
    if (open) {
      this.set({ terminalActive: open.key })
    } else {
      const tab = this.newTab(t)
      this.set({ terminalTabs: [...this.state.terminalTabs, tab], terminalActive: tab.key })
    }
    this.setSection('terminal')
  }

  /** Opens another terminal to the same task as a tab. */
  duplicateTerminal(tab: TerminalTab) {
    const copy = { ...tab, key: `tab-${++tabCount}` }
    const tabs = [...this.state.terminalTabs]
    tabs.splice(tabs.indexOf(tab) + 1, 0, copy)
    this.set({ terminalTabs: tabs, terminalActive: copy.key })
  }

  closeTerminal(key: string) {
    const tabs = this.state.terminalTabs
    const i = tabs.findIndex((x) => x.key === key)
    if (i < 0) return
    const rest = tabs.filter((x) => x.key !== key)
    const active = this.state.terminalActive === key ? (rest[Math.min(i, rest.length - 1)]?.key ?? null) : this.state.terminalActive
    this.set({ terminalTabs: rest, terminalActive: active })
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
  }
}

function same(a: AXTask[], b: AXTask[]) {
  return a.length === b.length && a.every((t, i) => JSON.stringify(t) === JSON.stringify(b[i]))
}

export const store = new Store()

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, () => store.state)
}

/** Kubernetes contexts, for ax builds without `ax config`: they take --context and default to kubectl's. */
async function kubeContexts(): Promise<AXContext[]> {
  const [names, current] = await Promise.all([
    window.studio.run({ program: 'kubectl', args: ['config', 'get-contexts', '-o', 'name'] }),
    window.studio.run({ program: 'kubectl', args: ['config', 'current-context'] }),
  ])
  const cur = result(current).ok ? result(current).stdout.trim() : ''
  const r = result(names)
  if (!r.ok) return []
  return r.stdout.split('\n').map((n) => n.trim()).filter(Boolean)
    .map((name) => ({ name, description: 'Kubernetes context', isCurrent: name === cur }))
}
