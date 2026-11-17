import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as sh from './shell'
import { createTray, updateTray } from './tray'
import type { PipeRequest, RunRequest, SessionRequest, StreamRequest, TraySummary } from '../shared/api'

const isMac = process.platform === 'darwin'
let win: BrowserWindow | null = null
/** Whether the window's page is up and listening for menu actions. */
let rendererReady = false
/** Menu bar actions waiting for the window to load. */
let pending: string[] = []

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
// `--screenshot=out.png` renders off-screen, saves the page and quits; it never takes focus.
const screenshot = arg('screenshot')

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'AX Studio',
    show: false,
    backgroundColor: screenshot ? '#f5f5f4' : '#00000000',
    // Native traffic lights inset into our own title bar on macOS; standard frame elsewhere.
    ...(isMac && !screenshot ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar' } : {}),
    icon: join(__dirname, '../../build-resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  rendererReady = false
  win.on('closed', () => {
    win = null
    updateTray(null)
  })
  if (screenshot) win.webContents.once('did-finish-load', () => setTimeout(() => void capture(screenshot), Number(arg('delay') ?? 6000)))
  else win.once('ready-to-show', () => win?.show())
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // `--section=clusters` opens a specific page; `--cluster=name` expands a
  // cluster card; `--context`, `--atespace` and `--task=name` open a task's inspector, and
  // `--logs=expanded` opens its logs in the large view; `--terminal=<command>`
  // opens its terminal and runs a command.
  const query: Record<string, string> = {}
  for (const k of ['section', 'cluster', 'context', 'atespace', 'task', 'logs', 'terminal']) {
    const v = arg(k)
    if (v) query[k] = v
  }
  const search = new URLSearchParams(query).toString()
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + (search ? `?${search}` : ''))
  else win.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

async function capture(file: string) {
  const image = await win!.webContents.capturePage()
  writeFileSync(expand(file), image.toPNG())
  app.quit()
}

function send(action: string) {
  win?.webContents.send('menu', action)
}

/** Runs a menu bar action in the window, opening it if it was closed. */
function act(action: string, show = true) {
  if (!win) createWindow()
  if (rendererReady) send(action)
  else pending.push(action)
  if (!show) return
  if (win!.isMinimized()) win!.restore()
  win!.show()
  app.focus({ steal: true })
}

function buildMenu() {
  const sections = ['overview', 'topology', 'designer', 'terminal', 'clusters']
  const titles = ['Activity', 'Map', 'Deploy', 'Terminal', 'Clusters']
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Task Design', accelerator: 'CmdOrCtrl+N', click: () => send('new-design') },
        { label: 'Open Manifest…', accelerator: 'CmdOrCtrl+O', click: () => send('open-manifest') },
        { label: 'Save Manifest…', accelerator: 'CmdOrCtrl+S', click: () => send('save-manifest') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'AX',
      submenu: [
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('refresh') },
        { label: 'Create Design', accelerator: 'CmdOrCtrl+Enter', click: () => send('apply') },
        { type: 'separator' },
        ...sections.map((s, i) => ({ label: titles[i], accelerator: `CmdOrCtrl+${i + 1}`, click: () => send(`section:${s}`) })),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIPC() {
  // The page sends a summary whenever its tasks change; the first one also
  // says it's ready for actions queued while it loaded.
  ipcMain.on('tray:update', (_e, summary: TraySummary) => {
    updateTray(summary)
    rendererReady = true
    for (const a of pending) send(a)
    pending = []
  })
  ipcMain.handle('platform', () => ({
    os: process.platform,
    home: homedir(),
    pathSeparator: delimiter,
    version: app.getVersion(),
  }))
  ipcMain.handle('run', (_e, req: RunRequest) => sh.run(req))
  ipcMain.handle('pipe', (_e, req: PipeRequest) => sh.pipe(req))
  ipcMain.handle('stream', (e, req: StreamRequest) => {
    sh.stream(
      req,
      (line) => !e.sender.isDestroyed() && e.sender.send('stream:line', { id: req.id, line }),
      (status) => !e.sender.isDestroyed() && e.sender.send('stream:exit', { id: req.id, status }),
    )
  })
  ipcMain.handle('cancelStream', (_e, id: string) => sh.cancel(id))
  ipcMain.handle('session:start', (e, req: SessionRequest) => {
    sh.startSession(
      req,
      (data, stream) => !e.sender.isDestroyed() && e.sender.send('session:data', { id: req.id, data, stream }),
      (status) => !e.sender.isDestroyed() && e.sender.send('session:exit', { id: req.id, status }),
    )
  })
  ipcMain.handle('session:write', (_e, id: string, data: string) => sh.writeSession(id, data))
  ipcMain.handle('session:interrupt', (_e, id: string) => sh.interruptSession(id))
  ipcMain.handle('session:eof', (_e, id: string) => sh.endSessionInput(id))
  ipcMain.handle('session:close', (_e, id: string) => sh.closeSession(id))
  ipcMain.handle('which', (_e, program: string) => sh.which(program))
  ipcMain.handle('kubeconfigFor', (_e, context: string) => sh.kubeconfigFor(context))
  ipcMain.handle('kubeconfig:set', (_e, value: string) => sh.setKubeconfig(value))
  ipcMain.handle('kubeconfig:info', () => sh.kubeconfigInfo())
  ipcMain.handle('kubeconfig:pick', async (_e, current: string) => {
    const first = current.split(delimiter)[0]?.trim()
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose kubeconfig file(s)',
      defaultPath: first ? expand(first) : join(homedir(), '.kube'),
      filters: [{ name: 'kubeconfig', extensions: ['yaml', 'yml', 'json', 'config', '*'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
    })
    if (r.canceled || !r.filePaths.length) return null
    return r.filePaths.join(delimiter)
  })
  ipcMain.handle('kubeconfig:sources', () => sh.kubeconfigSources())
  ipcMain.handle('kubeconfig:find', (_e, sourceId: string) => sh.findKubeconfigs(sourceId))
  ipcMain.handle('fileExists', (_e, path: string) => sh.pathExists(expand(path)))
  ipcMain.handle('containerRuntime', () => sh.containerRuntime(join(app.getPath('userData'), 'bin')))
  ipcMain.handle('openYAML', async (_e, defaultDir?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      defaultPath: defaultDir ? expand(defaultDir) : undefined,
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    return { path: r.filePaths[0], text: readFileSync(r.filePaths[0], 'utf8') }
  })
  ipcMain.handle('saveYAML', async (_e, name: string, text: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: name, filters: [{ name: 'YAML', extensions: ['yaml'] }] })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, text)
    return r.filePath
  })
}

function expand(p: string) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

app.setName('AX Studio')
app.whenReady().then(() => {
  registerIPC()
  buildMenu()
  createWindow()
  if (isMac && !screenshot) createTray({ act, quit: () => app.quit() })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => sh.cancelAll())
