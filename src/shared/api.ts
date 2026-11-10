// The bridge between the renderer and the main process. The renderer never
// touches Node directly; everything that spawns processes or touches the
// filesystem goes through these calls.

import type { KubeconfigInfo } from './kubeconfig'
export type { KubeconfigInfo }

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface RunRequest {
  program: string
  args: string[]
  stdin?: string
  cwd?: string
  env?: Record<string, string>
}

/** Two commands joined by a pipe: `from`'s stdout feeds `to`'s stdin as raw bytes. */
export interface PipeRequest {
  program: string
  from: string[]
  to: string[]
}

export interface StreamRequest {
  id: string
  /** Run by the platform shell (sh/zsh, or bash/cmd on Windows). */
  commandLine: string
  cwd?: string
  env?: Record<string, string>
}

export interface StreamLine {
  id: string
  line: string
}

export interface StreamExit {
  id: string
  status: number
}

export interface SessionRequest {
  id: string
  program: string
  args: string[]
}

/** Output from an interactive session: raw chunks, prompts and partial lines included. */
export interface SessionData {
  id: string
  data: string
  stream: 'stdout' | 'stderr'
}

export interface PlatformInfo {
  os: 'darwin' | 'win32' | 'linux' | string
  home: string
  pathSeparator: string
  version: string
}

export interface ContainerRuntime {
  runtime: 'docker' | 'podman' | null
  /** Environment overrides for commands that drive kind (PATH shim, kind provider). */
  env: Record<string, string>
}

/** What the menu bar icon shows: the Activity page in brief. */
export interface TraySummary {
  scope: string
  /** "2 running · 1 suspended", or why there's nothing to show. */
  status: string
  groups: { phase: string; tasks: { name: string; actions: ('resume' | 'suspend')[] }[] }[]
}

export interface StudioAPI {
  platform(): Promise<PlatformInfo>
  run(req: RunRequest): Promise<CommandResult>
  /** Runs `program from… | program to…`; fails if either side does. */
  pipe(req: PipeRequest): Promise<CommandResult>
  stream(req: StreamRequest): Promise<void>
  cancelStream(id: string): Promise<void>
  onStreamLine(cb: (l: StreamLine) => void): () => void
  onStreamExit(cb: (e: StreamExit) => void): () => void
  /** Starts an interactive process with piped stdio, e.g. `ax ssh <task> -- /bin/sh -i`. */
  startSession(req: SessionRequest): Promise<void>
  writeSession(id: string, data: string): Promise<void>
  /** Ctrl-C: sends SIGINT, which ax ssh forwards to the remote command. */
  interruptSession(id: string): Promise<void>
  /** Ctrl-D: closes stdin. */
  endSessionInput(id: string): Promise<void>
  closeSession(id: string): Promise<void>
  onSessionData(cb: (d: SessionData) => void): () => void
  onSessionExit(cb: (e: StreamExit) => void): () => void
  which(program: string): Promise<string | null>
  updateTray(summary: TraySummary): void
  /** Writes a kubeconfig that only sets current-context; returns a KUBECONFIG value. */
  kubeconfigFor(context: string): Promise<string>
  /** Points every ax and kubectl call at these kubeconfig file(s); '' restores the launch default. */
  setKubeconfig(value: string): Promise<KubeconfigInfo>
  kubeconfigInfo(): Promise<KubeconfigInfo>
  /** A file dialog for one or more kubeconfig files; returns a KUBECONFIG value or null if cancelled. */
  pickKubeconfig(current: string): Promise<string | null>
  fileExists(path: string): Promise<boolean>
  containerRuntime(): Promise<ContainerRuntime>
  openYAML(defaultDir?: string): Promise<{ path: string; text: string } | null>
  saveYAML(name: string, text: string): Promise<string | null>
  onMenu(cb: (action: string) => void): () => void
}

declare global {
  interface Window {
    studio: StudioAPI
  }
}
