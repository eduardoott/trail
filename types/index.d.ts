export type FileNode = {
  id: string
  parent: string
  name: string
  kind: 'dir' | 'file' | 'link'
  hidden: boolean
  mtime: number
  size: number
  loaded: boolean
}

export type Branch = {
  head: string
  upstream: string
  ahead: number
  behind: number
}

export type Activity = {
  id: number
  kind: string
  label: string
  state: 'running' | 'done' | 'failed'
  detail: string
  at: number
  tone: string
  nerd: string
  plain: string
}

export type FileTree = {
  root: string
  nodes: FileNode[]
  expanded: string[]
  cursor: string
  selected: string
  query: string
  showHidden: boolean
  showSize: boolean
  onlyChanged: boolean
  dirSizes: Record<string, number>
  git: Record<string, string>
  diff: Record<string, [number, number]>
  ignored: string[]
  untrackedDirs: string[]
  top: string
  prefix: string
  branch: Branch | null
  counts: Record<string, [number, number, number]>
  flash: string[]
  flashDim: string[]
  flashOn: boolean
  flashTones: Record<string, string>
  scroll: number | null
  preview: string
  previewTop: number
  tick: number
}

export type Theme = {
  fg: string
  accent: string
  muted: string
  urgent: string
  selection: string
  bg: string
}

// One step per command: calls sent together light together, so they replay together.
// edit: a file tool's light as its call starts, before its counts come in; it plays as an edit from the first frame.
export type StepFile = { added?: number; removed?: number; born?: boolean; gone?: boolean; edit?: boolean }
// shut: folders still closed when the command lit; the live light opens them, the replay shuts them again.
// names: the command's labels in order (`Read`, `sed`, `git commit`), see namesOf in hooks/replay.ts.
export type Step = { epoch: number; turn: number; tones: Record<string, string>; files?: Record<string, StepFile>; shut?: string[]; names?: string[] }

export type Repo = {
  key: string
  root: string
  kind: 'wsl' | 'win'
  distro: string
  linux: string
}

declare module 'claude-code' {
  interface PluginState {
    'trail': {
      tree: StateFamily<FileTree>
      activity: StateFamily<Activity[]>
      trail: StateFamily<Step[]>
      turn: number
      theme: Theme
      repos: Record<string, Repo>
      sessionTabDone: boolean
      startCwd: string
      quiet: Repo[]
    }
  }
}
