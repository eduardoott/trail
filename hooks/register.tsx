// Adapted from filetree 0.2.24 (Kurt Buhler), MIT License: see ../LICENSE.
// One tree per external repo root instead of one tree that follows the session cwd.
import { type BuiltinToolResults, type EngineInterface, type Register, type RenderInput, type Timer, update } from 'claude-code'
import { LINUX_LAUNCH, openCommand, openWithCommand } from './open'

import type { Activity, FileNode, FileTree, Repo, StepGit, Theme } from '../types'
import { BRANCH_ICON, chainOf, type GitAction, gitActions, RAMPS, readOnly, readTargets, resolve, TONES } from './git'
import type { RowSpec, RowsProps, Seg } from './rows'
import { CHEVRON_CLOSED, CHEVRON_OPEN, fileIcon, GIT_COLOR } from './icons'
import {
  ancestorsOf,
  type Change,
  DEFAULT_THEME,
  dirname,
  emptyTree,
  type FoldCtx,
  formatSize,
  inside,
  isAbsolute,
  isBig,
  join,
  mapper,
  parseGit,
  parseNumstat,
  parseTheme,
  posix,
  relative,
  dropBelow,
  useDrives,
  rollCounts,
  replaceChildren,
  rollUp,
  type Row,
  siblingOrder,
  stamp,
  toNodes,
  underAny,
  visibleRows,
} from './tree'
import { inRepo, linuxOf, mentions, paneId, resolveRepo, titleOf, toUnc } from './wsl'
import { type Blind, insideSession, shellBlind, shellReads, shellWrites, type Target, writeTargets } from './detect'
import { type Card, CARD_ROWS, drawCard } from './card'
import { BRANCH_ROW, CATCH, type Frame, type Kind, kindOf, lineDelta, LIVE, LIVE_QUEUE, namesOf, plan, rampOf, record, RUSH, splitStep, type Step, type StepFile, stepsFor, ticksOf, TIMING } from './replay'

const THEME = { plugin: 'trail', key: 'theme' } as const
const REPOS = { plugin: 'trail', key: 'repos' } as const
const SESSION_TAB_DONE = { plugin: 'trail', key: 'sessionTabDone' } as const
const START_CWD = { plugin: 'trail', key: 'startCwd' } as const
const QUIET = { plugin: 'trail', key: 'quiet' } as const
const REMEMBERED = 'remembered'
const CARD_ID = 'trail-card'
const HOLD_LIMIT_MS = 10 * 60 * 1000
const EARLY_MS = 1_200
const NO_ROOT_TTL_MS = 60_000
const POLL_MS = 250
// A hook's own budget is 10 s and a $.clock wait counts against it, so the hold waits
// inside a short child process instead. The first one that runs is kept.
const PAUSES = [
  ['node', '-e', `setTimeout(() => {}, ${POLL_MS})`],
  ['ping', '-n', '2', '127.0.0.1'],
  ['sleep', String(POLL_MS / 1000)],
]
const SHIMMER = Object.fromEntries(Object.entries(TONES).map(([k, v]) => [k, { bright: v.bright, dim: v.dim }]))
const RUNNING_MAX_MS = 600_000
const NO_REPO_DEPTH = 4
const DOUBLE_MS = 450
const FIND_LIMIT = 200
// A folder a command writes into without naming the files is listed before and after it, up to this many entries;
// past them the diff is left to the scan.
const BLIND_LIMIT = 2000
const NATIVE_ROWS = 150
const MIN_LIT_MS = 5000
// Tone (index into the ramp) of a folder on the way to a live-lit file: OPEN QUESTION, reference swatch is index 2.
const DIM_TONE = 2
const CHANGED_REVEAL_LIMIT = 400
const READ_REVEAL_LIMIT = 12
const SEARCH_REVEAL_LIMIT = 60
const ACTIVITY_TTL_MS = 45_000
const ADD_COLOR = '#98c379'
const DEL_COLOR = '#e06c75'
const THEME_FILE = '.local/state/omarchy/current/theme/colors.toml'
const THEME_POLL_MS = 2000
const PRUNE = ['.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', '.next']
const HOME_PRUNE = ['Library', 'AppData', '.Trash']
const SIZE_TIMEOUT_MS = 15_000
const SIZE_JOBS = 2
const SIZE_WALK_LIMIT = 50_000
const PREVIEW_CHARS = 90_000
const PREVIEW_LINE = 2_000

// `glyphs` and `column` come from userConfig; filetree's other options keep its defaults.
let glyphSetting = 'auto'
const openWithSetting = ''
const showReads = true
const showWrites = true
const followClaude = true
let sizeDefault = false
let tabFollows = true
let sessionTab = true
// reads (default yes): a Read, Grep or shell reader opens the tab and counts for the card, like a write.
let readsToo = true
let diagnose = false
// Phase 9: a folder with more direct children than this opens folded (0 turns the fold off).
let bigFolder = 200
// Replay skin: classic is the one-light-per-command player kept as it was; modern plays each step as frames.
let replayAnimation: 'classic' | 'modern' = 'modern'
// liveAnimation (modern only): animated plays each live light as the short replay of its step; instant lights at once, as before.
let liveAnimation: 'animated' | 'instant' = 'animated'
const liveOn = () => replayAnimation === 'modern' && liveAnimation === 'animated'
// The header button cycles the replay's speed: it scales the whole tick (2x, a tick of 25 ms; 5x, of 10 ms; 0.5x, of 100 ms).
const SPEEDS = [1, 2, 5, 0.5, 0.25] as const
let speed: number = 1
// modern: the icon of each kind of step, in the place of the row's glyph while it plays.
const ICONS: Record<Kind, { nerd: string; plain: string }> = {
  read: { nerd: '\u{f002}', plain: '⌕' },
  edit: { nerd: '\u{f040}', plain: '✎' },
  shell: { nerd: '\u{f120}', plain: '>' },
  born: { nerd: '\u{f067}', plain: '+' },
  gone: { nerd: '\u{f00d}', plain: '×' },
}
// auto: an edit in a git repo opens its tab; card: the card asks first, and a closed tab stays closed.
let opening: 'auto' | 'card' = 'auto'

let themePoll: Timer | null = null
let themeMtime: number | null = null
let lastPress = { key: '', at: 0 }
let noNerd = false
let activityId = 0
let pointer = true
let home = ''
let platform: Promise<'linux' | 'darwin' | 'win32'> | null = null
const instances = new Map<string, Instance>()
// One card at a time: a subagent's call waits for the one on screen.
let held: Card | null = null
let pauseAt = 0
let startCwd = ''
let inFlight = 0
// Bumped by each new command and by the end of the answer; a light from an older one arrives too late to show.
let lightEpoch = 0
let raisedEpoch = -1
let waiting = false
// Bumped by each prompt the person sends: the replay of the last interaction is this turn's steps.
let turn = 0
let replayToken = 0
let liveToken = 0
const REPLAY_STEP_MS = 2000
const views = new Map<string, { columns: number; isFullscreen?: boolean }>()
const roots = new Map<string, { repo: Repo | null; at: number }>()

// What the modern replay and the live light draw from: the frames of the step playing and where each row is in them.
type Player = {
  // The step playing (its rows only), its frames and the next one to apply.
  step: Step | null
  frames: Frame[]
  at: number
  // The bar's row, kept from one step to the next.
  bar: string | null
  // Files born in a later step (D6), and the rows of an opened folder not come in yet.
  hidden: Set<string>
  // Each folder still shut on the step's way: the rows that come in under it.
  kids: Record<string, string[]>
  // Tone 1..5 of each row lighting up or down, and the ramp of each row of the step.
  shade: Record<string, number>
  ramps: Record<string, string>
  // The labels of the command of each row of the step (its names), drawn as chips after the name while the row is lit.
  names: Record<string, string[]>
  icon: { file: string; kind: Kind; frame: number } | null
  // The icon of each file whose frames are done, drawn still in tone 3 for as long as the row stays lit:
  // the replay drops it on the file's settle, the live light when the row's light goes out.
  marks: Record<string, Kind>
  // Lines each file gained and lost, as far as its count went; kept to the end, like the settled tone.
  counts: Record<string, [number, number]>
  // Rows done playing: tone 2 of their ramp until the replay ends.
  settled: Record<string, string>
  ghosts: string[]
  // The replay only: files an earlier step made that the tree lost since (a later step removed them). They draw as
  // plain rows until the step that removed them plays them out as ghosts.
  phantoms?: string[]
  // The live light only. jump: a CATCH or RUSH plan, its folders open with no reveal, so their rows are never hidden.
  jump?: boolean
}

// classic uses index, total, token and timer only; modern also plays each step's frames.
type Replay = Player & {
  index: number
  total: number
  token: number
  timer: Timer | null
  modern: boolean
}

// liveAnimation animated: each light waits its turn in queue, one file a step, and plays a short plan of it (LIVE, CATCH
// or RUSH as the queue runs behind). step is the queued step itself, so a second light of the same command rides along with it.
type Live = Player & {
  queue: Step[]
  // The run since the queue was last empty, in files: queued, and played (the one playing counts) or lit at once.
  run: { total: number; done: number }
  token: number
  timer: Timer | null
  // Folders this step opened on its way: its lightUp sees them shut, as the light of today did.
  opened: string[]
  // The rows the plan lights (step's rows in the tree), for a CATCH plan from where it is.
  planned: Record<string, string>
  // The end of the answer came: the steps that were waiting light at once after the one playing.
  flush: Step[]
  // The epoch each file played or waits in, so the same command lighting it again does not play it twice.
  seen: Map<string, number>
  // The step's frames are done and it is being lit: the end of the answer only adds to flush.
  ending: boolean
  // Files a command made that the reload brings in before the queue has them: out of the tree until queued.
  coming: Set<string>
}

type Since = { ms: number; os: 'linux' | 'darwin' | 'win32' }
type Pending = { actions: GitAction[]; ids: number[]; command: string; head: string }
// names: the command's labels (namesOf), carried to the step its scan records.
// git: the command's git result, carried to the step its scan records.
type Job = { actions: GitAction[]; since: Since; initRepo: boolean; readOnly: boolean; epoch: number; files?: Record<string, StepFile>; names?: string[]; git?: StepGit }
type Background = { p: Pending | null; job: Job; reads: string[] }
type GitOperation = NonNullable<BuiltinToolResults['Bash']['gitOperation']>
type Outcome = { state: 'done' | 'failed'; label: string; detail: string }
type ToolResult = { deny?: unknown; isError?: boolean; isReadOnly?: boolean; result?: unknown }

const PROOF: Record<string, (op: GitOperation) => boolean> = {
  push: op => Boolean(op.push),
  merge: op => op.branch?.action === 'merged',
  rebase: op => op.branch?.action === 'rebased',
  'pr create': op => op.pr?.action === 'created',
  'pr merge': op => op.pr?.action === 'merged',
  'pr comment': op => op.pr?.action === 'commented',
}

function osName($: EngineInterface): Promise<'linux' | 'darwin' | 'win32'> {
  platform ??= (async () => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
    try {
      return (await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })).stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
    } catch {
      return 'linux'
    }
  })()
  return platform
}

async function cwdOf($: EngineInterface): Promise<string> {
  return posix(await $.session.cwd())
}

function clean(segs: Seg[]): Seg[] {
  for (const seg of segs) for (const k of Object.keys(seg) as (keyof Seg)[]) if (seg[k] === undefined) delete seg[k]
  return segs
}

function faint(hex: string): string {
  const v = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.round(0x26 + (((v >> shift) & 255) - 0x26) * 0.3)
  return `#${[16, 8, 0].map(x => ch(x).toString(16).padStart(2, '0')).join('')}`
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

function shortPath(path: string): string {
  return home && inside(home, path) ? `~${path.slice(home.length)}` : path
}

function broad(root: string): boolean {
  return root === home || root === '/' || /^[A-Za-z]:\/$/.test(root)
}

function rootOfDisk(root: string): boolean {
  return root === '/' || /^[A-Za-z]:\/$/.test(root)
}

function pruneArgs(root: string, ignored: string[] = []): string[] {
  const names = broad(root) ? [...PRUNE, ...HOME_PRUNE] : PRUNE
  return ['(', ...names.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name])), ...ignored.flatMap(p => ['-o', '-path', p]), ')', '-prune', '-o']
}

async function newer($: EngineInterface, paths: string[], sinceMs: number): Promise<string[]> {
  const stats = await Promise.all(
    paths.map(async p => {
      try {
        return (await $.fs.stat(p)).mtimeMs > sinceMs ? p : ''
      } catch {
        return ''
      }
    }),
  )
  return stats.filter(Boolean)
}

async function sinceNow($: EngineInterface): Promise<Since> {
  return { ms: await $.clock.now(), os: await osName($) }
}

function failAll(p: Pending): Outcome[] {
  return p.actions.map(a => ({ state: 'failed', label: `${a.verb} failed`, detail: '' }))
}

function proven(p: Pending | null, results: Outcome[]): GitAction[] {
  return p ? p.actions.filter((_, i) => results[i]?.state !== 'failed') : []
}

// The last action of the chain, as the live chip keeps it once all are done.
function gitOf(p: Pending | null, results: Outcome[]): StepGit | undefined {
  const i = (p?.actions.length ?? 0) - 1
  const a = p?.actions[i]
  const r = results[i]
  return a && r ? { kind: a.kind, label: r.label, running: a.running, state: r.state, detail: r.detail, tone: a.tone, nerd: a.icon.nerd, plain: a.icon.plain } : undefined
}

function taskEnds(text: string): [string, string][] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(m => {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(m[1] ?? '')?.[1]?.trim()
    const status = /<status>([^<]*)<\/status>/.exec(m[1] ?? '')?.[1]?.trim()
    return id && status ? [[id, status] as [string, string]] : []
  })
}

async function finePointerOk($: EngineInterface): Promise<boolean> {
  if (!(await $.env.get('HERDR_ENV'))) return true
  try {
    const out = (await $.process.run([(await $.env.get('HERDR_BIN_PATH')) || 'herdr', '--version'], { timeoutMs: 3_000 })).stdout
    const [major = 0, minor = 0, fix = 0] = (/(\d+)\.(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number)
    return major * 1e6 + minor * 1e3 + fix >= 9_001
  } catch {
    return false
  }
}

function fitSerialized(lines: string[], max: number): string[] {
  let size = 0
  for (let i = 0; i < lines.length; i++) {
    size += JSON.stringify(lines[i]).length
    if (size > max) return lines.slice(0, i)
  }
  return lines
}

function previewLines(text: string, top: number, rows: number, markdown: boolean): { text: string; top: number } {
  const lines = text.split('\n')
  const from = Math.max(0, Math.min(top, lines.length - 1))
  let shown = lines.slice(from, from + rows)
  if (markdown) {
    // Reopen a code fence the window starts inside, so the rest is not read as prose.
    let fence = ''
    let opener = ''
    for (const line of lines.slice(0, from)) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!m) continue
      const mark = m[1] ?? ''
      if (!fence) {
        fence = mark
        opener = line.trimStart()
      } else if (mark[0] === fence[0] && mark.length >= fence.length && !(m[2] ?? '').trim()) fence = ''
    }
    if (fence) shown = [opener, ...shown]
  }
  return { text: shown.join('\n'), top: from }
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  const os = await osName($)
  const native = (p: string) => (os === 'win32' ? p.replace(/\//g, '\\') : p)
  const custom = openWithCommand(openWithSetting, native(path), native(dirname(path)))
  const { argv, init } = custom ? { argv: os === 'linux' ? ['sh', '-c', LINUX_LAUNCH, 'sh', ...custom] : custom, init: { timeoutMs: 10_000 } } : openCommand(os, path)
  try {
    const run = await $.process.run(argv, init)
    if (run.exitCode !== 0) $.ui.toast(`could not open ${path} with ${custom?.[0] ?? argv[0]}: ${run.stderr.trim().split('\n')[0] || `exit ${run.exitCode}`}`)
  } catch {
    $.ui.toast(`could not open ${path} with ${custom?.[0] ?? argv[0]}`)
  }
}

async function loadTheme($: EngineInterface): Promise<void> {
  const path = `${(await $.env.get('HOME')) ?? ''}/${THEME_FILE}`
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file') throw new Error('no theme file')
    if (stat.mtimeMs === themeMtime) return
    await $.state.set(THEME, parseTheme(String(await $.fs.read(path))))
    themeMtime = stat.mtimeMs
  } catch {
    if (themeMtime === 0) return
    await $.state.set(THEME, DEFAULT_THEME)
    themeMtime = 0
  }
}

type Instance = {
  id: string
  repo: Repo
  blink: Timer | null
  fade: Timer | null
  litAt: Map<string, number>
  dueOut: Map<string, number>
  generation: number
  previewed: { path: string; text: string; note: string } | null
  previewRows: number
  scanning: Promise<void> | null
  scanJobs: Job[]
  gitRun: Promise<void> | null
  gitNext: Promise<void> | null
  queuedReads: string[]
  searchIndex: { root: string; paths: Promise<string[]> } | null
  // room: the rows of the pane's own window, where the replay's bar keeps to its band.
  view: { from: number; max: number; room: number }
  nativeScroll: boolean
  lastSync: number
  noDock: boolean
  dirty: { root: string; files: Record<string, Change> }
  listSeq: number
  sizeEpoch: number
  sizeActive: number
  sizeQueue: string[]
  alive: boolean
  sizing: Set<string>
  listLatest: Map<string, number>
  unreadable: Set<string>
  background: Map<string, Background>
  trail: Step[]
  replay: Replay | null
  live: Live | null
  // The ramp of each row the live light lit (files) or dimmed on their way (folders): kept past the player, to the light's end.
  lit: Record<string, string>
  pulse: Pulse | null
}

// The branch row's pulse while a git action runs: tone 2 3 4 3 of the action's ramp, a frame every 4 ticks.
type Pulse = { timer: Timer | null; frame: number }
const PULSE_TONES = [2, 3, 4, 3] as const
const PULSE_TICKS = 4

// Everything filetree kept in module variables, one copy per repo root.
function makeInstance(repo: Repo): Instance {
  return {
    id: paneId(repo.key),
    repo,
    blink: null,
    fade: null,
    litAt: new Map(),
    dueOut: new Map(),
    generation: 0,
    previewed: null,
    previewRows: 20,
    scanning: null,
    scanJobs: [],
    gitRun: null,
    gitNext: null,
    queuedReads: [],
    searchIndex: null,
    view: { from: 0, max: 0, room: 20 },
    nativeScroll: false,
    lastSync: 0,
    noDock: false,
    dirty: { root: '', files: {} },
    listSeq: 0,
    sizeEpoch: 0,
    sizeActive: 0,
    sizeQueue: [],
    alive: true,
    sizing: new Set(),
    listLatest: new Map(),
    unreadable: new Set(),
    background: new Map(),
    trail: [],
    replay: null,
    live: null,
    lit: {},
    pulse: null,
  }
}

const TREE = { plugin: 'trail', key: 'tree' } as const
const ACTIVITY = { plugin: 'trail', key: 'activity' } as const
// The trail and the turn live in $.state too: a reload starts the module over, and the replay keeps what came before it.
const TRAIL = { plugin: 'trail', key: 'trail' } as const
const TURN = { plugin: 'trail', key: 'turn' } as const

async function get($: EngineInterface, s: Instance): Promise<FileTree> {
  return { ...emptyTree(''), ...(await $.state.get({ ...TREE, id: s.id })).value }
}

async function put($: EngineInterface, s: Instance, fn: (t: FileTree) => FileTree): Promise<void> {
  await update($, { ...TREE, id: s.id }, cur => fn({ ...emptyTree(''), ...cur }))
}

function patch($: EngineInterface, s: Instance, fn: (t: FileTree) => Partial<FileTree>) {
  return put($, s, t => ({ ...t, ...fn(t) }))
}

async function activities($: EngineInterface, s: Instance): Promise<Activity[]> {
  return (await $.state.get({ ...ACTIVITY, id: s.id })).value ?? []
}

async function setActivities($: EngineInterface, s: Instance, fn: (list: Activity[]) => Activity[]): Promise<void> {
  await update($, { ...ACTIVITY, id: s.id }, cur => fn(cur ?? []).slice(-6))
}

async function list($: EngineInterface, s: Instance, dir: string): Promise<FileNode[] | null> {
  try {
    const entries = await $.fs.list(dir)
    const resolved = await Promise.all(
      entries.map(async e => {
        if (!e.isLink) return { name: e.name, kind: e.kind, mtimeMs: e.mtimeMs, size: e.size, isLink: false }
        try {
          const target = await $.fs.stat(join(dir, e.name))
          return target.kind === 'dir'
            ? { name: e.name, kind: 'dir' as const, mtimeMs: target.mtimeMs, size: 0, isLink: false }
            : { name: e.name, kind: 'file' as const, mtimeMs: target.mtimeMs, size: target.size, isLink: true }
        } catch {
          return { name: e.name, kind: 'other' as const, mtimeMs: 0, size: 0, isLink: true }
        }
      }),
    )
    s.unreadable.delete(dir)
    return toNodes(dir, resolved)
  } catch (err) {
    if (!(await exists($, dir))) return []
    if (!s.unreadable.has(dir)) {
      s.unreadable.add(dir)
      $.ui.toast(`could not list ${shortPath(dir)}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

async function loadDirs($: EngineInterface, s: Instance, dirs: string[]): Promise<Map<string, FileNode[]>> {
  const seq = ++s.listSeq
  for (const dir of dirs) s.listLatest.set(dir, seq)
  const results = await Promise.all(dirs.map(async dir => [dir, await list($, s, dir)] as const))
  const listed = new Map<string, FileNode[]>()
  for (const [dir, kids] of results) {
    if (s.listLatest.get(dir) !== seq) continue
    s.listLatest.delete(dir)
    if (kids) listed.set(dir, kids)
  }
  await patch($, s, t => (t.root === s.repo.root ? { nodes: replaceChildren(t.nodes, listed) } : {}))
  return listed
}

// The Windows git complains about ownership on \\wsl.localhost and is slow there, so WSL repos run the distro's git.
async function git($: EngineInterface, s: Instance, cwd: string, args: string[], timeoutMs = 20_000) {
  if (s.repo.kind === 'wsl') return $.process.run(['wsl.exe', '-d', s.repo.distro, '-e', 'git', '--no-optional-locks', '-C', linuxOf(s.repo, cwd), ...args], { timeoutMs })
  return $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs, env: { GIT_OPTIONAL_LOCKS: '0' } })
}

async function detectRepo($: EngineInterface, s: Instance): Promise<void> {
  let top = ''
  let prefix = ''
  try {
    const run = await git($, s, s.repo.root, ['rev-parse', '--show-prefix', '--show-toplevel'], 30_000)
    const [p = '', tl = ''] = run.exitCode === 0 ? run.stdout.replace(/\r/g, '').split('\n') : []
    prefix = p.trim()
    top = tl.trim()
    if (top && s.repo.kind === 'wsl') top = toUnc(s.repo.distro, top)
    else if (top) top = posix(top)
  } catch {
    top = ''
  }
  await patch($, s, () => ({ top, prefix }))
}

async function readGit($: EngineInterface, s: Instance): Promise<void> {
  const t = await get($, s)
  if (!t.root || !t.top) return
  const root = t.root
  try {
    const status = await git($, s, root, ['status', '--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'])
    if (status.exitCode !== 0) return
    const parsed = parseGit(status.stdout, root, t.prefix)
    const diff: Record<string, [number, number]> = {}
    const head = await git($, s, root, ['diff', 'HEAD', '--numstat', '-z', '--', '.'])
    if (head.exitCode === 0) parseNumstat(head.stdout, root, t.prefix, diff)
    const files = { ...parsed.files }
    if (parsed.untrackedDirs.length) {
      const others = await git($, s, root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...parsed.untrackedDirs.map(d => d.slice(root.length + 1) || '.')])
      if (others.exitCode === 0) for (const rel of others.stdout.split('\0').filter(Boolean)) files[join(root, rel)] = 'new'
    }
    for (const path of Object.keys(diff)) if (files[path] === 'new') delete diff[path]
    s.dirty = { root, files }
    await patch($, s, cur =>
      cur.root === root
        ? {
            git: parsed.git,
            ignored: parsed.ignored,
            untrackedDirs: parsed.untrackedDirs,
            branch: parsed.branch,
            counts: rollCounts(files, root),
            diff: rollUp(diff, root),
          }
        : {},
    )
    if ((await get($, s)).onlyChanged) await revealChanged($, s)
  } catch {
    return
  }
}

// The changed files sit in folders nobody opened yet, so the filter loads their parents.
async function revealChanged($: EngineInterface, s: Instance): Promise<void> {
  if (s.dirty.root === s.repo.root) await revealPaths($, s, Object.keys(s.dirty.files).slice(0, CHANGED_REVEAL_LIMIT))
}

function refreshGit($: EngineInterface, s: Instance): Promise<void> {
  if (!s.gitRun) {
    s.gitRun = readGit($, s).finally(() => {
      s.gitRun = null
    })
    return s.gitRun
  }
  const rerun = () => {
    s.gitNext = null
    return refreshGit($, s)
  }
  s.gitNext ??= s.gitRun.then(rerun, rerun)
  return s.gitNext
}

async function openPane($: EngineInterface, s: Instance, focus = false) {
  return $.ui.open({ id: s.id, title: titleOf(s.repo), ...(focus ? { focus: true } : {}) })
}

async function reset($: EngineInterface, s: Instance, focus = false) {
  const prev = await get($, s)
  s.generation += 1
  s.blink?.cancel()
  s.blink = null
  stopLive(s)
  forgetLit(s)
  s.searchIndex = null
  s.sizeEpoch += 1
  s.sizeQueue = []
  await put($, s, () => ({ ...emptyTree(s.repo.root), showHidden: prev.showHidden, onlyChanged: prev.onlyChanged ?? false, showSize: prev.root ? prev.showSize : sizeDefault }))
  const opened = focus || !s.noDock ? await openPane($, s, focus) : null
  await loadDirs($, s, [s.repo.root])
  await detectRepo($, s)
  await refreshGit($, s)
  return opened
}

async function revealPaths($: EngineInterface, s: Instance, paths: string[]): Promise<void> {
  const tried = new Set<string>()
  for (let pass = 0; pass < 32; pass++) {
    const t = await get($, s)
    const loaded = new Set(t.nodes.filter(n => n.loaded).map(n => n.id))
    if (t.nodes.some(n => n.parent === t.root)) loaded.add(t.root)
    const need = new Set<string>()
    for (const p of paths) {
      for (const dir of [t.root, ...ancestorsOf(p, t.root).reverse()]) {
        if (!loaded.has(dir)) {
          if (!tried.has(dir)) need.add(dir)
          break
        }
      }
    }
    if (need.size === 0) return
    for (const dir of need) tried.add(dir)
    await loadDirs($, s, [...need])
  }
}

async function changedSince($: EngineInterface, s: Instance, root: string, depth: number, ignored: string[] = [], since: Since): Promise<string[]> {
  if (rootOfDisk(root)) return []
  try {
    const run = await $.process.run(['find', '-H', root, '-xdev', ...(depth ? ['-maxdepth', String(depth)] : []), ...pruneArgs(root, ignored.filter(p => inside(root, p)).slice(0, 40)), '-newermt', `@${(since.ms / 1000).toFixed(3)}`, '-print0'], { timeoutMs: 8_000 })
    return run.stdout.split('\0').filter(p => p && p !== root)
  } catch {
    return []
  }
}

async function changedInRepo($: EngineInterface, s: Instance, root: string, since: Since, before: Record<string, Change>, ignored: string[]): Promise<{ hits: string[]; gone: string[] }> {
  if (since.os !== 'win32') return { hits: await changedSince($, s, root, 0, ignored, since), gone: [] }
  if (s.dirty.root !== root) return { hits: [], gone: [] }
  const entries = Object.entries(s.dirty.files)
  const gone = entries.filter(([p, c]) => c === 'del' && before[p] !== 'del').map(([p]) => p)
  const live = entries.filter(([, c]) => c !== 'del').map(([p]) => p)
  return { hits: await newer($, live.slice(0, 4_000), since.ms), gone }
}

async function walkSize($: EngineInterface, s: Instance, dir: string): Promise<number> {
  let total = 0
  let seen = 0
  let level = [dir]
  while (level.length) {
    const next: string[] = []
    for (const d of level) {
      let entries
      try {
        entries = await $.fs.list(d)
      } catch {
        continue
      }
      for (const e of entries) {
        if (++seen > SIZE_WALK_LIMIT) return -1
        if (e.kind === 'dir' && !e.isLink) next.push(join(d, e.name))
        else if (e.kind === 'file') total += e.size
      }
    }
    level = next
  }
  return total
}

async function dirSize($: EngineInterface, s: Instance, dir: string): Promise<number> {
  if (rootOfDisk(dir)) return -1
  if ((await osName($)) === 'win32') return walkSize($, s, dir)
  try {
    const run = await $.process.run(['du', '-skxH', dir], { timeoutMs: SIZE_TIMEOUT_MS })
    const kb = Number(run.stdout.trim().split(/\s/)[0] || NaN)
    return Number.isFinite(kb) ? kb * 1024 : -1
  } catch {
    return -1
  }
}

function pumpSizes($: EngineInterface, s: Instance): void {
  while (s.sizeActive < SIZE_JOBS && s.sizeQueue.length) {
    const dir = s.sizeQueue.shift() ?? ''
    const epoch = s.sizeEpoch
    s.sizing.add(dir)
    s.sizeActive += 1
    void dirSize($, s, dir)
      .then(async bytes => {
        if (epoch === s.sizeEpoch) return patch($, s, cur => (inside(cur.root, dir) ? { dirSizes: { ...cur.dirSizes, [dir]: bytes } } : {}))
        const cur = await get($, s)
        if (cur.showSize && inside(cur.root, dir) && !(dir in cur.dirSizes) && !s.sizeQueue.includes(dir)) s.sizeQueue.push(dir)
      })
      .catch(() => undefined)
      .finally(() => {
        s.sizing.delete(dir)
        s.sizeActive -= 1
        pumpSizes($, s)
      })
  }
}

function wantSizes($: EngineInterface, s: Instance, dirs: string[]): void {
  for (const dir of dirs) if (!s.sizing.has(dir) && !s.sizeQueue.includes(dir)) s.sizeQueue.push(dir)
  pumpSizes($, s)
}

async function staleSizes($: EngineInterface, s: Instance, paths?: string[]): Promise<void> {
  s.sizeEpoch += 1
  s.sizeQueue = []
  await patch($, s, cur => {
    if (!paths) return { dirSizes: {} }
    const keep: Record<string, number> = {}
    for (const [dir, bytes] of Object.entries(cur.dirSizes)) if (!paths.some(p => inside(dir, p))) keep[dir] = bytes
    return { dirSizes: keep }
  })
}

function openDirs(t: FileTree): string[] {
  const open = new Set(t.expanded)
  return t.nodes.filter(n => n.kind === 'dir' && n.loaded && open.has(n.id)).map(n => n.id)
}

function keepTop(s: Instance, cur: FileTree, expanded: string[]): Partial<FileTree> {
  if (followClaude) return { scroll: null }
  const ctx = foldCtx(s, cur)
  const top = visibleRows(cur, ctx)[cur.scroll ?? s.view.from]?.node.id
  const at = top ? visibleRows({ ...cur, expanded }, ctx).findIndex(r => r.node.id === top) : -1
  return at < 0 ? {} : { scroll: at }
}

// What a folded folder keeps: every file the session's steps lit, the ones lit now, and the live light's rows.
function touchedOf(s: Instance, t: FileTree): Set<string> {
  const out = new Set<string>()
  for (const step of s.trail) for (const id of Object.keys(step.tones)) if (id !== BRANCH_ROW) out.add(id)
  for (const id of t.flash) if (id !== BRANCH_ROW) out.add(id)
  for (const id of Object.keys(s.lit)) if (id !== BRANCH_ROW) out.add(id)
  return out
}

function foldCtx(s: Instance, t: FileTree): FoldCtx {
  return { touched: touchedOf(s, t), limit: bigFolder }
}

// The folder's direct children the pane can show, as visibleRows counts them for the fold.
function kidCounts(t: FileTree): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of t.nodes) if (t.showHidden || !n.hidden) out.set(n.parent, (out.get(n.parent) ?? 0) + 1)
  return out
}

const FOLD_KEY = '\u0000'
const enUS = new Intl.NumberFormat('en-US')

const DARK = { flash: [], flashDim: [], flashOn: false, flashTones: {} } satisfies Partial<FileTree>

function lightUp(cur: FileTree, tones: Record<string, string>): Partial<FileTree> & { expanded: string[] } {
  const unique = Object.keys(tones)
  const open = new Set(cur.expanded)
  const bright = new Set([...(cur.flashOn ? cur.flash.filter(id => !unique.includes(id)) : []), ...unique])
  const dim = new Set<string>()
  const all: Record<string, string> = cur.flashOn ? { ...cur.flashTones } : {}
  if (cur.flashOn) {
    for (const id of cur.flashDim) dim.add(id)
  }
  for (const id of unique) {
    const tone = tones[id] ?? 'orange'
    all[id] = tone
    if (id === BRANCH_ROW) continue
    const chain = ancestorsOf(id, cur.root)
    if (!chain.some(a => !open.has(a))) continue
    for (const a of chain) {
      if (!open.has(a)) {
        dim.add(a)
        all[a] = all[a] ?? tone
      }
      open.add(a)
    }
  }
  for (const id of bright) dim.delete(id)
  return { flash: [...bright], flashDim: [...dim], flashOn: true, flashTones: all, expanded: [...open] }
}

// names: the labels of the command that lit these rows; the step keeps them (record unions the early light's and the result's).
async function flash($: EngineInterface, s: Instance, tones: Record<string, string>, epoch = lightEpoch, files?: Record<string, StepFile>, names?: string[], git?: StepGit): Promise<void> {
  const unique = Object.keys(tones)
  // Recorded even when it arrives late: a commit's green after the answer ended still belongs to its command.
  // A file born here replays green; one gone replays as a ghost.
  const kept = files
    ? {
        ...Object.fromEntries(Object.keys(files).filter(p => files[p]?.gone).map(p => [p, 'orange'])),
        ...tones,
        ...Object.fromEntries(Object.keys(tones).filter(p => files[p]?.born).map(p => [p, 'green'])),
      }
    : tones
  if (Object.keys(kept).length === 0) return
  const before = await get($, s)
  const open = new Set(before.expanded)
  // The live light still on its way to these opens their folders: for the replay they were open, as the light of today left them.
  for (const one of s.live ? [s.live.step, ...s.live.flush, ...s.live.queue] : []) for (const id of Object.keys(one?.tones ?? {})) if (id !== BRANCH_ROW) for (const dir of ancestorsOf(id, before.root)) open.add(dir)
  const shut = [...new Set(unique.filter(id => id !== BRANCH_ROW).flatMap(id => ancestorsOf(id, before.root)).filter(dir => !open.has(dir)))]
  s.trail = record(s.trail, { epoch, turn, tones: files ? kept : tones, ...(files ? { files } : {}), ...(shut.length ? { shut } : {}), ...(names?.length ? { names } : {}), ...(git ? { git } : {}) })
  void $.state.set({ ...TRAIL, id: s.id }, s.trail)
  // liveAnimation animated plays a gone file too, as the replay does: its row stays, a ghost once the tree lost it, until its
  // step played it out. The instant light has no row to light.
  const gone = liveOn() && files ? Object.keys(files).filter(p => files[p]?.gone && !(p in tones) && inside(before.root, p)) : []
  if (epoch !== lightEpoch || unique.length + gone.length === 0) return
  await stopReplay($, s)
  // liveAnimation animated: the light waits its turn and plays on the pane's clock; the call never waits for it.
  if (liveOn()) return queueLive($, s, { ...tones, ...Object.fromEntries(gone.map(p => [p, 'orange'])) }, epoch, files, names)
  const mine = ++s.generation
  s.blink?.cancel()
  s.blink = null
  await patch($, s, cur => {
    const lit = lightUp(cur, tones)
    return { ...lit, ...keepTop(s, cur, lit.expanded) }
  })
  // A newer command or the end of the answer came in while this light was drawn: it goes out on the usual clock.
  const stale = epoch !== lightEpoch
  const now = await $.clock.now()
  for (const id of unique) {
    if (stale && s.dueOut.has(id)) continue
    s.litAt.set(id, now)
    s.dueOut.delete(id)
  }
  if (stale || waiting) await unlight($, s)
}

// The light stays on what the last command touched until the next command starts or the answer ends,
// and never for less than MIN_LIT_MS, so a read that takes an instant still shows.
async function unlight($: EngineInterface, s: Instance): Promise<void> {
  await stopReplay($, s)
  // The live bar stays on the last file through the answer and goes with it, once nothing is left to play.
  if (waiting && s.live && !s.live.step && !s.live.queue.length) await dropLive($, s)
  s.generation += 1
  s.blink?.cancel()
  s.blink = null
  const cur = await get($, s)
  if (!cur.flashOn) return
  for (const id of cur.flash) if (!s.dueOut.has(id)) s.dueOut.set(id, (s.litAt.get(id) ?? 0) + MIN_LIT_MS)
  await fadeDue($, s)
}

async function fadeDue($: EngineInterface, s: Instance): Promise<void> {
  s.fade?.cancel()
  s.fade = null
  const now = await $.clock.now()
  const out = new Set([...s.dueOut].filter(([, at]) => at <= now).map(([id]) => id))
  for (const id of out) {
    s.dueOut.delete(id)
    s.litAt.delete(id)
    // The live mark goes out with the row's light.
    if (s.live) delete s.live.marks[id]
    delete s.lit[id]
  }
  if (out.size)
    await patch($, s, cur => {
      const next = dropLit(cur, out)
      // A folder's ramp goes with its dim light, or a later instant light would draw it in a stale ramp.
      const keep = new Set([...(next.flash ?? []), ...(next.flashDim ?? [])])
      for (const id of Object.keys(s.lit)) if (!keep.has(id)) delete s.lit[id]
      return next
    })
  if (s.dueOut.size) s.fade = $.clock.after(Math.max(0, Math.min(...s.dueOut.values()) - now), () => void fadeDue($, s))
}

function dropLit(cur: FileTree, out: Set<string>): Partial<FileTree> {
  const flash = cur.flash.filter(id => !out.has(id))
  if (!flash.length) return { flash: [], flashDim: [], flashOn: false, flashTones: {} }
  const under = new Set(flash.filter(id => id !== BRANCH_ROW).flatMap(id => ancestorsOf(id, cur.root)))
  const flashDim = cur.flashDim.filter(id => under.has(id))
  const keep = new Set([...flash, ...flashDim])
  return { flash, flashDim, flashTones: Object.fromEntries(Object.entries(cur.flashTones).filter(([id]) => keep.has(id))) }
}

function forgetLit(s: Instance): void {
  s.fade?.cancel()
  s.fade = null
  s.dueOut.clear()
  s.litAt.clear()
  s.lit = {}
}

// Each step is its own timer callback, not one long await, because a hook's budget is 10 s.
async function play($: EngineInterface, s: Instance, scope: 'last' | 'all'): Promise<void> {
  if (s.replay) return stopReplay($, s)
  const steps = stepsFor(s.trail, scope, turn)
  if (!steps.length) return
  // The live light gives the pane over: what waits lights at once, and the replay plays as ever.
  await drainLive($, s)
  s.generation += 1
  s.blink?.cancel()
  s.blink = null
  forgetLit(s)
  const token = ++replayToken
  const modern = replayAnimation === 'modern'
  s.replay = { index: 0, total: steps.length, token, timer: null, modern, step: null, frames: [], at: 0, bar: null, hidden: new Set(), kids: {}, shade: {}, ramps: {}, names: {}, icon: null, marks: {}, counts: {}, settled: {}, ghosts: [] }
  await patch($, s, () => DARK)
  if (modern) await playModern($, s, steps, token)
  else await playClassic($, s, steps, token)
}

// The rows the pane draws: the replay's hidden rows out, its ghosts in among their old siblings. A ghost whose row
// the tree still has (the live light plays a removal before the reload takes the row out) draws as that row.
function paneRows(s: Instance, t: FileTree, r: Player | null): { rows: Row[]; ghosts: Set<string>; phantoms: Set<string> } {
  const unborn = r && 'queue' in r ? unbornOf(r as Live) : null
  const hidden = unborn?.size ? new Set([...(r?.hidden ?? []), ...unborn]) : r?.hidden
  const all = visibleRows(t, foldCtx(s, t))
  const rows = hidden?.size ? all.filter(x => !hidden.has(x.node.id)) : all
  const ghosts = new Set<string>()
  const phantoms = new Set<string>()
  const extra = [...(r?.ghosts ?? []), ...(r?.phantoms ?? [])]
  const there = extra.length ? new Set(all.map(x => x.node.id)) : null
  for (const g of extra) {
    if (there?.has(g) || hidden?.has(g)) continue
    const parent = dirname(g)
    const at = parent === t.root ? -1 : rows.findIndex(x => x.node.id === parent)
    if (parent !== t.root && !rows[at]?.open) continue
    const depth = at < 0 ? 0 : rows[at]!.depth + 1
    const node: FileNode = { id: g, parent, name: g.slice(g.lastIndexOf('/') + 1), kind: 'file', hidden: false, mtime: 0, size: 0, loaded: false }
    let i = at + 1
    while (i < rows.length && rows[i]!.depth >= depth && !(rows[i]!.depth === depth && siblingOrder(node, rows[i]!.node) < 0)) i++
    rows.splice(i, 0, { node, depth, open: false })
    if (r?.ghosts.includes(g)) ghosts.add(g)
    else phantoms.add(g)
  }
  return { rows, ghosts, phantoms }
}

// The live light's D6: a file born in a step still waiting stays out of the tree until its step plays (or lights at
// once), and so does one the reload brought in before the queue had it.
function unbornOf(L: Live): Set<string> {
  const out = new Set(L.coming)
  for (const one of [...L.queue, ...L.flush]) for (const [p, f] of Object.entries(one.files ?? {})) if (f.born) out.add(p)
  return out
}

// Where the render puts the window when nothing is lit and it has no scroll of its own: on the cursor.
function centered(at: number, room: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, at) - Math.floor(room / 2), length - room))
}

// The window moves only when the bar leaves the band, just enough to bring it back.
function follow(s: Instance, t: FileTree, ids: string[], row: string): number {
  const room = s.view.room
  const max = Math.max(0, ids.length - room)
  let top = Math.max(0, Math.min(t.scroll ?? centered(ids.indexOf(t.cursor), room, ids.length), max))
  const at = ids.indexOf(row)
  if (at >= 0 && at < top + TIMING.bandTop) top = at - TIMING.bandTop
  else if (at >= 0 && at > top + room - TIMING.bandBottom) top = at - room + TIMING.bandBottom
  return Math.max(0, Math.min(top, max))
}

// modern: each step is a list of frames (replay.ts plan), played by playFrames.
async function playModern($: EngineInterface, s: Instance, steps: Step[], token: number): Promise<void> {
  const r = s.replay
  if (!r || r.token !== token) return
  if (r.index >= steps.length) return stopReplay($, s)
  const step = steps[r.index]!
  r.index += 1
  // D6: a file born in a later step stays out of the tree until then; this step's own come in now.
  r.hidden = new Set(steps.slice(r.index).flatMap(one => Object.entries(one.files ?? {}).filter(([, f]) => f.born).map(([p]) => p)))
  r.ghosts = []
  r.shade = {}
  r.icon = null
  r.marks = {}
  r.frames = []
  r.at = 0
  const root = (await get($, s)).root
  const files = Object.keys(step.tones).filter(p => p !== BRANCH_ROW && inside(root, p))
  await revealPaths($, s, files)
  if (s.replay !== r) return
  // B1: the folders the live light opened shut again, so the bar opens them on its way.
  if (step.shut?.length) await patch($, s, cur => ({ expanded: cur.expanded.filter(d => !step.shut!.includes(d)) }))
  if (s.replay !== r) return
  const cur = await get($, s)
  if (s.replay !== r) return
  const shown = new Set(cur.nodes.map(n => n.id))
  // A file this step removed plays as a ghost in its folder; any other file gone since is skipped.
  const ghosts = files.filter(p => step.files?.[p]?.gone && !shown.has(p) && (dirname(p) === root || shown.has(dirname(p))))
  // A file born in a step played so far and not removed by one yet, that the tree has lost since: it stays a row.
  const played = steps.slice(0, r.index)
  const last = (p: string, k: 'born' | 'gone') => played.findLastIndex(one => one.files?.[p]?.[k])
  const madeHere = (p: string) => last(p, 'born') > last(p, 'gone')
  const phantoms = [...new Set(played.flatMap(one => Object.keys(one.files ?? {})))].filter(p => madeHere(p) && !shown.has(p) && inside(root, p) && (dirname(p) === root || shown.has(dirname(p))))
  const tones = Object.fromEntries(Object.entries(step.tones).filter(([p]) => p === BRANCH_ROW || shown.has(p) || ghosts.includes(p) || phantoms.includes(p)))
  r.ghosts = ghosts
  r.phantoms = phantoms
  // Born again in a later step (made, removed, made again) does not hide the row it has now.
  for (const p of [...ghosts, ...phantoms]) r.hidden.delete(p)
  // This step's own new files come in one by one, each as the bar reaches it, as the live light does.
  const own = Object.keys(tones).filter(p => step.files?.[p]?.born && shown.has(p) && !phantoms.includes(p))
  const order = paneRows(s, { ...cur, expanded: [...new Set([...cur.expanded, ...own.flatMap(p => ancestorsOf(p, root))])] }, r).rows.map(x => x.node.id)
  for (const p of own) r.hidden.add(p)
  r.step = { ...step, tones }
  r.ramps = Object.fromEntries(Object.keys(tones).map(p => [p, p === BRANCH_ROW ? (RAMPS[tones[p]!] ? tones[p]! : 'teal') : rampOf(step, p)]))
  r.names = Object.fromEntries(Object.keys(tones).map(p => [p, step.names ?? []]))
  const ids = paneRows(s, cur, r).rows.map(x => x.node.id)
  // The bar sets out from the person's cursor when it shows, else it lands on the first row it visits.
  if (r.bar === null && ids.includes(cur.cursor)) r.bar = cur.cursor
  r.kids = kidsOf(s, cur, root, tones, r)
  r.frames = plan(r.step, ids, r.bar, r.kids, TIMING, false, own.length ? { order, ids: new Set(own) } : undefined)
  await patch($, s, t => ({ tick: t.tick + 1 }))
  if (s.replay !== r) return
  // A step left with nothing to light plays no frame: the next one starts at once.
  await playFrames($, s, steps, token)
}

// One timer per frame that takes time: the frames due now (open and settle take none) apply together,
// draw once, and the next call waits their ticks, scaled by the speed button.
async function playFrames($: EngineInterface, s: Instance, steps: Step[], token: number): Promise<void> {
  const r = s.replay
  if (!r || r.token !== token) return
  if (r.at >= r.frames.length) return playModern($, s, steps, token)
  const t = await get($, s)
  if (s.replay !== r) return
  const { opened, scroll, ticks } = applyFrames(s, t, r)
  await patch($, s, cur => ({ ...(opened.length ? { expanded: [...new Set([...cur.expanded, ...opened])] } : {}), ...(scroll === undefined ? {} : { scroll }), tick: cur.tick + 1 }))
  if (s.replay !== r) return
  if (!ticks) return playModern($, s, steps, token)
  r.timer = $.clock.after((ticks * TIMING.tick) / speed, () => void playFrames($, s, steps, token))
}

async function playClassic($: EngineInterface, s: Instance, steps: Step[], token: number): Promise<void> {
  const r = s.replay
  if (!r || r.token !== token) return
  if (r.index >= steps.length) {
    s.replay = null
    await patch($, s, () => DARK)
    return
  }
  const step = steps[r.index]!
  r.index += 1
  const root = (await get($, s)).root
  const files = Object.keys(step.tones).filter(p => p !== BRANCH_ROW && inside(root, p))
  await revealPaths($, s, files)
  if (s.replay?.token !== token) return
  const shown = new Set((await get($, s)).nodes.map(n => n.id))
  const tones = Object.fromEntries(Object.entries(step.tones).filter(([p]) => p === BRANCH_ROW || shown.has(p)))
  // A file that is gone since is skipped, and so is a step left with nothing to light.
  const wait = Object.keys(tones).length ? REPLAY_STEP_MS : 0
  await patch($, s, cur => (wait ? lightUp({ ...cur, ...DARK }, tones) : DARK))
  r.timer = $.clock.after(wait, () => void playClassic($, s, steps, token))
}

// Serves both players. modern also hands the window back: the render draws natively again on the desktop.
// Its bar, icon, tones and hidden rows live on the replay, so they all go in this one draw.
async function stopReplay($: EngineInterface, s: Instance): Promise<void> {
  const r = s.replay
  if (!r) return
  r.timer?.cancel()
  s.replay = null
  await patch($, s, cur => (r.modern ? { ...DARK, scroll: null, tick: cur.tick + 1 } : DARK))
}

// Each folder still shut on the way to the step's rows, outermost first: the rows that come in under it once it opens.
function kidsOf(s: Instance, cur: FileTree, root: string, tones: Record<string, string>, p: Player): Record<string, string[]> {
  const open = new Set(cur.expanded)
  const kids: Record<string, string[]> = {}
  for (const f of Object.keys(tones)) {
    if (f === BRANCH_ROW) continue
    for (const dir of ancestorsOf(f, root).reverse()) {
      if (open.has(dir) || dir in kids) continue
      const all = paneRows(s, { ...cur, expanded: [...cur.expanded, ...ancestorsOf(dir, root), dir] }, p).rows
      const at = all.findIndex(x => x.node.id === dir)
      if (at < 0) continue
      const list: string[] = []
      for (let i = at + 1; i < all.length && all[i]!.depth > all[at]!.depth; i++) list.push(all[i]!.node.id)
      kids[dir] = list
    }
  }
  return kids
}

// The frames due now (open and settle take none) applied to the player, the folders to open in this draw and
// the ticks until the next. A jump plan opens its folders with every row in at once.
function applyFrames(s: Instance, t: FileTree, p: Player): { opened: string[]; scroll: number | undefined; ticks: number } {
  const opened: string[] = []
  const ids = () => paneRows(s, { ...t, expanded: [...t.expanded, ...opened] }, p).rows.map(x => x.node.id)
  let scroll: number | undefined
  let ticks = 0
  while (!ticks && p.at < p.frames.length) {
    const f = p.frames[p.at++]!
    // The icon cycles on its own frames only, as in the mock; past them it stays as a still mark.
    if (f.kind !== 'icon') markIcon(p)
    if (f.kind === 'bar') {
      p.bar = f.row
      scroll = follow(s, t, ids(), f.row)
    } else if (f.kind === 'open') {
      opened.push(f.dir)
      if (!p.jump) for (const id of p.kids[f.dir] ?? []) p.hidden.add(id)
    } else if (f.kind === 'reveal') for (const id of f.ids) p.hidden.delete(id)
    else if (f.kind === 'shade') p.shade[f.file] = f.shade
    else if (f.kind === 'icon') {
      p.icon = { file: f.file, kind: kindOf(p.step!, f.file), frame: f.frame }
      const info = p.step?.files?.[f.file]
      if (info && (info.added !== undefined || info.removed !== undefined)) p.counts[f.file] = [Math.round((info.added ?? 0) * f.count), Math.round((info.removed ?? 0) * f.count)]
    } else if (f.kind === 'settle') {
      const file = f.file
      delete p.shade[file]
      // The replay's mark leaves with the settle; the live one stays until the row's light goes out, a ghost's with it.
      if (p !== s.live || p.ghosts.includes(file)) delete p.marks[file]
      if (p.ghosts.includes(file)) {
        // A gone file leaves the list, and the bar keeps its line: plan routes on from the row now there.
        const was = ids()
        const at = was.indexOf(file)
        const left = was.filter(id => id !== file)
        p.ghosts = p.ghosts.filter(g => g !== file)
        if (p.bar === file) p.bar = at >= 0 && left.length ? left[Math.min(at, left.length - 1)]! : null
      } else p.settled[file] = p.ramps[file] ?? 'teal'
    }
    ticks = ticksOf([f])
  }
  return { opened, scroll, ticks }
}

// The icon's frames are over: it stays on its row as a still mark of its kind.
function markIcon(p: Player): void {
  if (!p.icon) return
  if (p.step) p.marks[p.icon.file] = kindOf(p.step, p.icon.file)
  p.icon = null
}

// modern's step with a git result on the branch row: its chip in the running form, on the pulse driven by the
// replay's frames, until the branch settles (or the step's last row, the branch having no frames beside files), then final.
function replayedGit(r: Replay | null): { a: Activity; bg?: string } | null {
  const g = r?.modern && r.frames.length && r.step && BRANCH_ROW in r.step.tones ? r.step.git : undefined
  if (!r || !g) return null
  const settles = r.frames.flatMap((f, i) => (f.kind === 'settle' ? [i] : []))
  const own = r.frames.findIndex(f => f.kind === 'settle' && f.file === BRANCH_ROW)
  const end = own >= 0 ? own : (settles.at(-1) ?? -1)
  const a: Activity = { id: 0, at: 0, kind: g.kind, label: g.label, state: g.state, detail: g.detail, tone: g.tone, nerd: g.nerd, plain: g.plain }
  if (r.at > end) return { a }
  return { a: { ...a, label: g.running, state: 'running', detail: '' }, bg: (RAMPS[g.tone] ?? RAMPS.teal!)[PULSE_TONES[r.at % PULSE_TONES.length]!] }
}

function newLive(): Live {
  return { queue: [], run: { total: 0, done: 0 }, token: 0, timer: null, step: null, frames: [], at: 0, bar: null, hidden: new Set(), kids: {}, shade: {}, ramps: {}, names: {}, icon: null, marks: {}, counts: {}, settled: {}, ghosts: [], jump: false, opened: [], planned: {}, flush: [], seen: new Map(), ending: false, coming: new Set() }
}

// The queue is counted in lights, not in commands: a grep that reads ten files is ten (a step holds one, or the branch).
const lightsOf = (step: Step) => Math.max(1, Object.keys(step.tones).filter(p => p !== BRANCH_ROW).length)

// flash's side when liveAnimation is animated. A row this command already has on its way rides along with it (tone and
// counts); one it already played lights again at once, as before; the rest wait their turn as a step of their own.
// names: the command's labels, kept on the step as record keeps them (the early light's and the result's, once each).
async function queueLive($: EngineInterface, s: Instance, tones: Record<string, string>, epoch: number, files?: Record<string, StepFile>, names?: string[]): Promise<void> {
  const L = (s.live ??= newLive())
  // A step already being lit takes no more riders: its rows light again at once instead.
  const pending = [L.ending ? null : L.step, ...L.queue].filter((x): x is Step => x !== null && x.epoch === epoch)
  const fresh: Record<string, string> = {}
  const again: Record<string, string> = {}
  for (const [id, tone] of Object.entries(tones)) {
    const home = pending.find(x => id in x.tones)
    if (home) {
      home.tones[id] = tone
      const f = files?.[id]
      if (f) home.files = { ...home.files, [id]: { ...home.files?.[id], ...f } }
      if (names?.length) home.names = [...new Set([...(home.names ?? []), ...names])]
      // The result of an Edit lands while its early light plays: the row's ramp follows its kind, as its icon does.
      if (home === L.step && id in L.ramps) {
        L.ramps[id] = rampOf(home, id)
        L.names[id] = home.names ?? []
      }
      // A removal its result confirms keeps its row, a ghost once the tree lost it, until its step played it out.
      if (home.files?.[id]?.gone && !L.ghosts.includes(id)) L.ghosts.push(id)
    } else if (L.seen.get(id) === epoch) {
      // Its frames already played it out: a gone file has no row left to light again.
      if (files?.[id]?.gone) continue
      again[id] = tone
      // Its frames ended before the result came: the still mark and the settled tone take the kind the result says.
      const f = files?.[id]
      if (f) {
        const one: Step = { epoch, turn, tones: { [id]: tone }, files: { [id]: f } }
        if (id in L.marks) L.marks[id] = kindOf(one, id)
        if (id in L.marks) L.ramps[id] = rampOf(one, id)
        if (id in L.marks && names?.length) L.names[id] = [...new Set([...(L.names[id] ?? []), ...names])]
        s.lit[id] = rampOf(one, id)
      }
    }
    else fresh[id] = tone
  }
  // The oldest waiting past LIVE_QUEUE.overflow light at once, as a row lit again does: the animation stays on the
  // newest, and every row before the one playing is already lit, in the order the files came.
  let early: Step[] = []
  if (Object.keys(fresh).length) {
    for (const id of Object.keys(fresh)) L.seen.set(id, epoch)
    const own = Object.fromEntries(Object.entries(files ?? {}).filter(([p]) => p in fresh))
    const steps = splitStep({ epoch, turn, tones: fresh, ...(Object.keys(own).length ? { files: own } : {}), ...(names?.length ? { names } : {}) })
    if (!L.step && !L.queue.length) L.run = { total: 0, done: 0 }
    L.run.total += steps.reduce((n, x) => n + lightsOf(x), 0)
    L.queue.push(...steps)
    for (const one of steps) for (const p of Object.keys(one.tones)) if (one.files?.[p]?.gone && !L.ghosts.includes(p)) L.ghosts.push(p)
    const over = L.queue.length - LIVE_QUEUE.overflow
    if (over > 0) {
      const out = L.queue.splice(0, over)
      L.run.done += out.reduce((n, x) => n + lightsOf(x), 0)
      early = leaving(L, out, []).steps
      for (const one of early) for (const p of Object.keys(one.tones)) if (p !== BRANCH_ROW) s.lit[p] = rampOf(one, p)
    }
    void playLive($, s)
  }
  if (Object.keys(again).length) early.push({ epoch, turn, tones: again })
  if (!early.length) return
  const stale = await lightSteps($, s, early, [])
  if (stale || waiting) await unlight($, s)
}

// One file at a time off the queue, each a timer per frame. LIVE when it found the player idle; CATCH (the bar jumps)
// when lights wait behind it, the one that just played counting; RUSH from LIVE_QUEUE.rush on.
async function playLive($: EngineInterface, s: Instance, chained = false): Promise<void> {
  const L = s.live
  if (!L || L.step) return
  if (!L.queue.length) {
    L.run = { total: 0, done: 0 }
    return
  }
  const behind = L.queue.reduce((n, x) => n + lightsOf(x), 0) + (chained ? 1 : 0)
  const step = L.queue.shift()!
  const token = (L.token = ++liveToken)
  L.step = step
  L.run.done += lightsOf(step)
  L.jump = behind >= LIVE_QUEUE.catch
  const timing = behind >= LIVE_QUEUE.rush ? RUSH : L.jump ? CATCH : LIVE
  const cur = await get($, s)
  if (s.live !== L || L.token !== token) return
  const root = cur.root
  const shown = new Set(cur.nodes.map(n => n.id))
  // A gone file the tree lost plays as its ghost, in the folder it was in; with that folder gone too it is skipped.
  const ghost = (p: string) => L.ghosts.includes(p) && (dirname(p) === root || shown.has(dirname(p)))
  const tones = Object.fromEntries(Object.entries(step.tones).filter(([p]) => p === BRANCH_ROW || ((shown.has(p) || ghost(p)) && inside(root, p))))
  L.planned = tones
  // The ramps of the rows still marked stay, so their marks keep their tone.
  L.ramps = { ...Object.fromEntries(Object.entries(L.ramps).filter(([p]) => p in L.marks)), ...Object.fromEntries(Object.keys(tones).map(p => [p, p === BRANCH_ROW ? (RAMPS[tones[p]!] ? tones[p]! : 'teal') : rampOf(step, p)])) }
  L.names = { ...Object.fromEntries(Object.entries(L.names).filter(([p]) => p in L.marks)), ...Object.fromEntries(Object.keys(tones).map(p => [p, step.names ?? []])) }
  const ids = paneRows(s, cur, L).rows.map(x => x.node.id)
  // The bar sets out from where the last step left it, else from the person's cursor when it shows.
  if (L.bar === null && ids.includes(cur.cursor)) L.bar = cur.cursor
  L.kids = kidsOf(s, cur, root, tones, L)
  L.frames = plan({ ...step, tones }, ids, L.bar, L.kids, timing, L.jump)
  L.at = 0
  await liveFrames($, s, L, token)
}

// One timer per frame that takes time, scaled by the speed button, as the replay.
async function liveFrames($: EngineInterface, s: Instance, L: Live, token: number): Promise<void> {
  const mine = () => s.live === L && L.token === token
  if (!mine()) return
  if (L.at >= L.frames.length) return endLive($, s, L, token)
  const t = await get($, s)
  if (!mine()) return
  const { opened, scroll, ticks } = applyFrames(s, t, L)
  L.opened.push(...opened)
  await patch($, s, cur => ({ ...(opened.length ? { expanded: [...new Set([...cur.expanded, ...opened])] } : {}), ...(scroll === undefined ? {} : { scroll }), tick: cur.tick + 1 }))
  if (!mine()) return
  if (!ticks) return endLive($, s, L, token)
  L.timer = $.clock.after((ticks * TIMING.tick) / speed, () => void liveFrames($, s, L, token))
}

// The step's last frame: it lights as flash lit it before, with the steps the end of the answer left waiting after
// it, the next step starts, and a light a newer command overtook goes out on the usual clock.
async function endLive($: EngineInterface, s: Instance, L: Live, token: number): Promise<void> {
  L.ending = true
  let steps = [L.step!, ...L.flush.splice(0)]
  let opened = L.opened
  // The marks stay: they go with the row's light, not with the step.
  markIcon(L)
  Object.assign(L, { frames: [], at: 0, shade: {}, icon: null, counts: {}, settled: {}, hidden: new Set(), kids: {}, opened: [], planned: {}, jump: false })
  let stale = false
  while (steps.length) {
    // The steps the end of the answer left waiting light at once: done in the run's count.
    L.run.done += steps.slice(steps[0] === L.step ? 1 : 0).reduce((n, x) => n + lightsOf(x), 0)
    const out = leaving(L, steps, opened)
    for (const one of out.steps) for (const p of Object.keys(one.tones)) if (p !== BRANCH_ROW) s.lit[p] = rampOf(one, p)
    stale = (await lightSteps($, s, out.steps, out.opened)) || stale
    if (s.live !== L || L.token !== token) return
    steps = L.flush.splice(0)
    opened = []
  }
  L.ending = false
  L.step = null
  void playLive($, s, true)
  // Nothing left to play: one more draw parks the bar and gives the desktop its native scroll back.
  if (!L.step) await patch($, s, cur => ({ tick: cur.tick + 1 }))
  if (stale || waiting) await unlight($, s)
}

// Steps leaving the live player, to light at once: their gone files leave the pane (no row to keep lit), and a folder
// opened on the way to one stays open, with no lit file in it to dim it.
function leaving(L: Live, steps: Step[], opened: string[]): { steps: Step[]; opened: string[] } {
  const gone = (one: Step, p: string) => Boolean(one.files?.[p]?.gone)
  const out = steps.flatMap(one => Object.keys(one.tones).filter(p => gone(one, p)))
  if (!out.length) return { steps, opened }
  L.ghosts = L.ghosts.filter(g => !out.includes(g))
  for (const p of out) delete L.marks[p]
  return {
    steps: steps.map(one => ({ ...one, tones: Object.fromEntries(Object.entries(one.tones).filter(([p]) => !gone(one, p))) })),
    opened: opened.filter(dir => !out.some(p => inside(dir, p))),
  }
}

// Steps lit at once, as flash lit them before. The folders a live step opened on its way count as shut, so lightUp
// dims them and the tree ends as the light of today leaves it. True when a newer command came in since.
async function lightSteps($: EngineInterface, s: Instance, steps: Step[], opened: string[]): Promise<boolean> {
  s.generation += 1
  s.blink?.cancel()
  s.blink = null
  await patch($, s, cur => {
    let t: FileTree = { ...cur, expanded: cur.expanded.filter(d => !opened.includes(d)) }
    for (const one of steps) {
      t = { ...t, ...lightUp(t, one.tones) }
      const dim = new Set(t.flashDim)
      for (const p of Object.keys(one.tones)) {
        if (p === BRANCH_ROW) continue
        const ramp = (s.lit[p] ??= rampOf(one, p))
        for (const a of ancestorsOf(p, t.root)) if (dim.has(a)) s.lit[a] = ramp
      }
    }
    return { flash: t.flash, flashDim: t.flashDim, flashOn: t.flashOn, flashTones: t.flashTones, expanded: t.expanded, tick: cur.tick + 1 }
  })
  const now = await $.clock.now()
  let stale = false
  for (const one of steps) {
    const old = one.epoch !== lightEpoch
    stale ||= old
    for (const id of Object.keys(one.tones)) {
      if (old && s.dueOut.has(id)) continue
      s.litAt.set(id, now)
      s.dueOut.delete(id)
    }
  }
  return stale
}

// The end of the answer while a step plays: it finishes in CATCH from where it is (the bar jumps, the rows still to
// come in show at once), and the steps waiting light at once right after it.
async function finishLive($: EngineInterface, s: Instance): Promise<void> {
  const L = s.live
  if (!L?.step) return
  L.flush.push(...L.queue.splice(0))
  if (L.ending || L.jump) return
  L.timer?.cancel()
  L.timer = null
  const token = (L.token = ++liveToken)
  const cur = await get($, s)
  if (s.live !== L || L.token !== token) return
  L.jump = true
  L.hidden = new Set()
  L.shade = {}
  markIcon(L)
  const tones = Object.fromEntries(Object.entries(L.planned).filter(([p]) => !(p in L.settled)))
  L.kids = kidsOf(s, cur, cur.root, tones, L)
  L.frames = plan({ ...L.step, tones }, paneRows(s, cur, L).rows.map(x => x.node.id), L.bar, L.kids, CATCH, true)
  L.at = 0
  void liveFrames($, s, L, token)
}

// ▷ over the live light: the step playing and those waiting light at once and the player stops, so the replay has
// the pane to itself.
async function drainLive($: EngineInterface, s: Instance): Promise<void> {
  const L = s.live
  if (!L) return
  L.timer?.cancel()
  s.live = null
  const steps = [L.step, ...L.flush, ...L.queue].filter((x): x is Step => x !== null)
  if (steps.length) await lightSteps($, s, steps, L.opened)
  await patch($, s, cur => ({ scroll: null, tick: cur.tick + 1 }))
}

// The live player leaves the pane with nothing left to play: no bar, the window the render's own again.
async function dropLive($: EngineInterface, s: Instance): Promise<void> {
  stopLive(s)
  await patch($, s, cur => ({ scroll: null, tick: cur.tick + 1 }))
}

function stopLive(s: Instance): void {
  s.live?.timer?.cancel()
  s.live = null
}

function stopPulse(s: Instance): void {
  s.pulse?.timer?.cancel()
  s.pulse = null
}

function startPulse($: EngineInterface, s: Instance): void {
  if (s.pulse || !liveOn()) return
  const P: Pulse = { timer: null, frame: 0 }
  s.pulse = P
  P.timer = $.clock.after((PULSE_TICKS * TIMING.tick) / speed, () => void pulseFrame($, s, P))
}

async function pulseFrame($: EngineInterface, s: Instance, P: Pulse): Promise<void> {
  const mine = () => s.pulse === P
  if (!mine()) return
  const now = await $.clock.now()
  // A run the tool never answered: the render drops it at RUNNING_MAX_MS, the pulse with it.
  const running = (await activities($, s)).some(a => a.state === 'running' && now - a.at < RUNNING_MAX_MS)
  if (!mine()) return
  if (!running) return stopPulse(s)
  P.frame += 1
  await patch($, s, cur => ({ tick: cur.tick + 1 }))
  if (!mine()) return
  P.timer = $.clock.after((PULSE_TICKS * TIMING.tick) / speed, () => void pulseFrame($, s, P))
}

// The pulse follows the activities: on while one runs, off once none does.
async function settlePulse($: EngineInterface, s: Instance): Promise<void> {
  const running = (await activities($, s)).some(a => a.state === 'running')
  if (running) startPulse($, s)
  else stopPulse(s)
  await patch($, s, cur => ({ tick: cur.tick + 1 }))
}

// Lit as the call starts, from what the call names, before the tool has run.
async function lightEarly($: EngineInterface, e: { tool: string }, epoch: number, cwd: string | null = null): Promise<void> {
  const command = commandOf(e)
  const ps = e.tool === 'PowerShell'
  const file = command ? '' : e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'Read' ? fileOf(e) : ''
  const names = namesOf(e.tool, command)
  const named: [string, string, boolean][] = file
    ? [[file, e.tool === 'Read' ? 'purple' : 'orange', false]]
    : command
      ? [...shellReads(command, ps, home, cwd).map(t => [t.path, 'purple', false] as [string, string, boolean]), ...shellWrites(command, ps, home, false, false, cwd).map(t => [t.path, 'orange', Boolean(t.gone)] as [string, string, boolean])]
      : []
  for (const inst of instances.values()) {
    const tones: Record<string, string> = {}
    const removed = new Set<string>()
    for (const [path, tone, gone] of named) {
      const p = inRepo(inst.repo, path)
      if (p && p !== inst.repo.root && (tone === 'purple' ? showReads : showWrites)) tones[p] = tone
      if (p && gone) removed.add(p)
    }
    if (!Object.keys(tones).length) continue
    await revealPaths($, inst, Object.keys(tones))
    // A file not in the tree yet (a Write about to create it) has no row to play on: its result lights it, born.
    const have = new Set((await get($, inst)).nodes.map(n => n.id))
    for (const p of Object.keys(tones)) if (!have.has(p)) delete tones[p]
    if (!Object.keys(tones).length) continue
    // A file tool's write is an edit before its result says how many lines: pencil and orange from the first frame.
    // A shell removal is gone the same way: × and the red ramp from the first frame, its result confirming it.
    const files: Record<string, StepFile> = file && e.tool !== 'Read' ? Object.fromEntries(Object.keys(tones).map(p => [p, { edit: true }])) : Object.fromEntries(Object.keys(tones).filter(p => removed.has(p)).map(p => [p, { gone: true }]))
    await flash($, inst, tones, epoch, Object.keys(files).length ? files : undefined, names)
  }
}

async function startGit($: EngineInterface, s: Instance, actions: GitAction[]): Promise<number[]> {
  const now = await $.clock.now()
  const ids = actions.map(() => ++activityId)
  await setActivities($, s, cur => [
    ...cur.filter(a => a.state === 'running' || now - a.at < ACTIVITY_TTL_MS),
    ...actions.map((a, i) => ({
      id: ids[i] ?? 0,
      kind: a.kind,
      label: a.running,
      state: 'running' as const,
      detail: '',
      at: now,
      tone: a.tone,
      nerd: a.icon.nerd,
      plain: a.icon.plain,
    })),
  ])
  await settlePulse($, s)
  return ids
}

async function headOf($: EngineInterface, s: Instance): Promise<string> {
  try {
    const run = await git($, s, s.repo.root, ['rev-parse', 'HEAD'], 5_000)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function outcomes($: EngineInterface, s: Instance, p: Pending, ok: boolean, op: GitOperation | undefined): Promise<Outcome[]> {
  const chain = chainOf(p.command)
  const after = p.actions.some(a => a.verb === 'commit') && !op?.commit ? await headOf($, s) : ''
  return p.actions.map(a => {
    if (a.verb === 'commit') {
      const sha = op?.commit?.sha || (after && after !== p.head ? after : '')
      return sha ? { state: 'done', label: a.done, detail: sha.slice(0, 7) } : { state: 'failed', label: `${a.verb} failed`, detail: '' }
    }
    if ((op && PROOF[a.verb]?.(op)) || (ok && chain.and)) return { state: 'done', label: a.done, detail: '' }
    if (!ok && chain.and && chain.size === 1) return { state: 'failed', label: `${a.verb} failed`, detail: '' }
    return { state: 'done', label: `ran ${a.kind}`, detail: '' }
  })
}

async function finishGit($: EngineInterface, s: Instance, p: Pending, results: Outcome[]): Promise<void> {
  const now = await $.clock.now()
  await setActivities($, s, cur =>
    cur.map(a => {
      const i = p.ids.indexOf(a.id)
      const result = i < 0 ? undefined : results[i]
      return result ? { ...a, ...result, at: now } : a
    }),
  )
  await settlePulse($, s)
  $.clock.after(ACTIVITY_TTL_MS + 500, () => void setActivities($, s, cur => cur.filter(a => a.state === 'running' || a.at > now)))
}

async function settleBackground($: EngineInterface, s: Instance, text: string): Promise<void> {
  if (s.background.size === 0 || !text.includes('<task-notification>')) return
  for (const [taskId, status] of taskEnds(text)) {
    const task = s.background.get(taskId)
    if (!task) continue
    s.background.delete(taskId)
    const ok = status === 'completed'
    const results = task.p ? await outcomes($, s, task.p, ok, undefined) : []
    if (task.p) await finishGit($, s, task.p, results)
    if (showReads) s.queuedReads.push(...task.reads)
    const done = gitOf(task.p, results)
    scheduleScan($, s, { ...task.job, actions: proven(task.p, results), epoch: lightEpoch, ...(done ? { git: done } : {}) })
  }
}

async function gitPaths($: EngineInterface, s: Instance, root: string, prefix: string, committed: boolean): Promise<string[]> {
  const map = mapper(root, prefix)
  try {
    const run = committed
      ? await git($, s, root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], 5_000)
      : await git($, s, root, ['diff', '--cached', '--name-only', '-z'], 5_000)
    return run.exitCode === 0 ? run.stdout.split('\0').filter(Boolean).flatMap(rel => map(rel) ?? []) : []
  } catch {
    return []
  }
}

async function sync($: EngineInterface, s: Instance, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - s.lastSync < 2_000) return
  s.lastSync = now
  s.searchIndex = null
  const t = await get($, s)
  if (!t.root) return
  await loadDirs($, s, [t.root, ...openDirs(t)])
  if (t.top) await refreshGit($, s)
}

async function copyPath($: EngineInterface, s: Instance, path: string, absolute: boolean, surface?: string): Promise<void> {
  const t = await get($, s)
  const text = !absolute && path !== t.root && inside(t.root, path) ? path.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : path
  const done = await $.ui.copy({ text, ...(surface ? { surface: surface as 'terminal' } : {}) })
  $.ui.toast(done.isCopied ? `Copied ${text}` : 'Could not copy the path')
}

async function afterBash($: EngineInterface, s: Instance, jobs: Job[]): Promise<void> {
  const epoch = Math.max(...jobs.map(j => j.epoch))
  const reads = s.queuedReads
  s.queuedReads = []
  const t = await get($, s)
  if (!t.root) return
  const actions = jobs.flatMap(j => j.actions)
  const writers = jobs.filter(j => !j.readOnly)
  const since = (writers.length ? writers : jobs).reduce((a, j) => (j.since.ms < a.ms ? j.since : a), (writers[0] ?? jobs[0])?.since ?? { ms: 0, os: 'linux' as const })
  const writes = !jobs.every(j => j.readOnly)
  const before = s.dirty.root === t.root ? s.dirty.files : {}
  if (jobs.some(j => j.initRepo) || !t.top) await detectRepo($, s)
  const probed = await get($, s)
  if (probed.top && (writes || probed.top !== t.top)) await refreshGit($, s)
  if (writes) {
    s.searchIndex = null
    await staleSizes($, s)
  }
  const fresh = await get($, s)
  const ignored = new Set(fresh.ignored)
  const tones: Record<string, string> = {}
  // What each command saw born or gone; jobs that came together all count.
  const files: Record<string, StepFile> = {}
  for (const j of jobs) for (const [p, f] of Object.entries(j.files ?? {})) files[p] = { ...files[p], ...f }
  // The labels of every command that came together: the first job's order, no repeats.
  const names = [...new Set(jobs.flatMap(j => j.names ?? []))]
  const gitDone = jobs.flatMap(j => (j.git ? [j.git] : [])).at(-1)
  if (writes) {
    const found = fresh.top
      ? await changedInRepo($, s, t.root, since, before, fresh.ignored)
      : { hits: since.os === 'win32' ? [] : await changedSince($, s, t.root, NO_REPO_DEPTH, [], since), gone: [] }
    for (const p of found.gone) if (inside(t.root, p) && !underAny(p, ignored, t.root)) files[p] = { ...files[p], gone: true }
    const hits = found.hits.filter(x => inside(t.root, x) && !underAny(x, ignored, t.root)).slice(0, FIND_LIMIT)
    // What the command removed joins the live queue before the reload takes its rows out: each stays drawn, a ghost
    // once the tree lost it, until its step played it out.
    const gone = Object.entries(files).filter(([p, f]) => f.gone && inside(t.root, p))
    if (gone.length) await flash($, s, {}, epoch, Object.fromEntries(gone), names)
    // The files the command was seen to make that the scan missed (written through a loop's variable) light as its hits.
    const born = Object.keys(files).filter(p => files[p]?.born && !hits.includes(p) && inside(t.root, p) && !underAny(p, ignored, t.root))
    // A hit the tree did not have, under a folder it had listed (or one missing too), was born: it comes in on its
    // own step, green, and until its step plays the live light keeps it out of the tree the reload is about to fill.
    const had = new Set(t.nodes.map(n => n.id))
    const listedDir = new Set(t.nodes.filter(n => n.loaded).map(n => n.id))
    if (t.nodes.some(n => n.parent === t.root)) listedDir.add(t.root)
    const isNew = (p: string) => {
      if (had.has(p)) return false
      let d = dirname(p)
      while (d !== t.root && inside(t.root, d) && !had.has(d)) d = dirname(d)
      return listedDir.has(d)
    }
    for (const p of hits) if (isNew(p)) files[p] = { ...files[p], born: true }
    if (liveOn() && showWrites) (s.live ??= newLive()).coming = new Set([...hits, ...born].filter(p => files[p]?.born))
    await revealPaths($, s, [...hits, ...born])
    const loaded = await get($, s)
    const dirs = [...new Set([loaded.root, ...openDirs(loaded), ...hits.map(dirname), ...born.map(dirname), ...found.gone.map(dirname)])].filter(d => inside(loaded.root, d))
    const listed = await loadDirs($, s, dirs)
    if (!fresh.top && since.os === 'win32')
      for (const kids of listed.values()) for (const n of kids) if (n.mtime > since.ms && hits.length < FIND_LIMIT) hits.push(n.id)
    await patch($, s, cur => {
      const ids = new Set(cur.nodes.map(n => n.id))
      return { expanded: cur.expanded.filter(x => ids.has(x)) }
    })
    const nodes = (await get($, s)).nodes
    const present = new Set(nodes.map(n => n.id))
    const touchTone = actions.find(a => !['commit', 'push', 'add'].includes(a.verb))?.tone ?? 'orange'
    if (showWrites) for (const x of hits) if (present.has(x)) tones[x] = touchTone
    // A folder born (mkdir) lights as the way to its files, as before, not as a step of its own.
    const folders = new Set(nodes.filter(n => n.kind === 'dir').map(n => n.id))
    if (showWrites) for (const x of born) if (present.has(x) && !folders.has(x)) tones[x] = touchTone
  }
  if (showReads) {
    const found: string[] = []
    for (const r of reads) {
      if (found.length >= READ_REVEAL_LIMIT) break
      if (r !== t.root && inside(t.root, r) && !underAny(r, ignored, t.root) && (await exists($, r))) found.push(r)
    }
    if (found.length) {
      await revealPaths($, s, found)
      const shown = new Set((await get($, s)).nodes.map(n => n.id))
      for (const r of found) if (shown.has(r) && !tones[r]) tones[r] = 'purple'
    }
  }
  if (showWrites && actions.length) {
    const final = await get($, s)
    const committed = actions.some(a => a.verb === 'commit')
    if ((committed || actions.some(a => a.verb === 'add')) && final.top) {
      const paths = (await gitPaths($, s, final.root, final.prefix, committed)).filter(x => !underAny(x, ignored, final.root)).slice(0, READ_REVEAL_LIMIT)
      await revealPaths($, s, paths)
      const shown = new Set((await get($, s)).nodes.map(n => n.id))
      for (const x of paths) if (shown.has(x)) tones[x] = 'green'
    }
    const pushLike = actions.find(a => ['push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'tag'].includes(a.verb) || a.kind.startsWith('gh '))
    if (pushLike) tones[BRANCH_ROW] = pushLike.tone
    else if (committed) tones[BRANCH_ROW] = 'green'
  }
  // A failed action proves nothing to light: its branch row lights red, so the replay has a step to draw the failure on.
  if (showWrites && gitDone?.state === 'failed' && !tones[BRANCH_ROW]) tones[BRANCH_ROW] = 'red'
  try {
    await flash($, s, tones, epoch, Object.keys(files).length ? files : undefined, names, gitDone)
  } finally {
    // Queued now, the waiting steps keep them out; one that never got a step comes in.
    if (s.live?.coming.size) {
      s.live.coming = new Set()
      await patch($, s, cur => ({ tick: cur.tick + 1 }))
    }
  }
}

function scheduleScan($: EngineInterface, s: Instance, job: Job): void {
  s.scanJobs.push(job)
  if (s.scanning) return
  s.scanning = (async () => {
    while (s.scanJobs.length && s.alive) {
      const jobs = s.scanJobs
      s.scanJobs = []
      await afterBash($, s, jobs)
    }
  })().finally(() => {
    s.scanning = null
  })
}

async function touched($: EngineInterface, s: Instance, paths: string[], tone: string, show: boolean, epoch = lightEpoch, files?: Record<string, StepFile>, names?: string[]): Promise<void> {
  if (tone !== 'purple' && s.previewed && paths.includes(s.previewed.path)) s.previewed = null
  const t = await get($, s)
  if (!t.root) return
  const within = paths.filter(p => inside(t.root, p))
  if (within.length === 0) return
  if (tone !== 'purple') {
    s.searchIndex = null
    await staleSizes($, s, within)
    await revealPaths($, s, within.map(dirname))
    await loadDirs($, s, [...new Set(within.map(dirname))].filter(d => inside(t.root, d)))
    await refreshGit($, s)
  } else await revealPaths($, s, within)
  if (!show) return
  const tones: Record<string, string> = {}
  for (const p of within) tones[p] = tone
  await flash($, s, tones, epoch, files, names)
}

async function walk($: EngineInterface, s: Instance, root: string, depth: number, limit: number): Promise<string[]> {
  const out: string[] = []
  let level = [root]
  for (let d = 0; d < depth && level.length && out.length < limit; d++) {
    const next: string[] = []
    for (const dir of level) {
      for (const n of (await list($, s, dir)) ?? []) {
        if (n.kind === 'dir') {
          if (!PRUNE.includes(n.name)) next.push(n.id)
        } else out.push(n.id)
      }
      if (out.length >= limit) break
    }
    level = next
  }
  return out
}

async function listAll($: EngineInterface, s: Instance, t: FileTree): Promise<string[] | null> {
  try {
    if (!t.top && (await osName($)) === 'win32') return await walk($, s, t.root, rootOfDisk(t.root) ? 3 : 6, 20_000)
    const run = t.top
      ? await git($, s, t.root, ['ls-files', '-co', '--exclude-standard', '-z'], 10_000)
      : await $.process.run(['find', '-H', t.root, '-xdev', '-maxdepth', rootOfDisk(t.root) ? '3' : '6', ...pruneArgs(t.root), '-type', 'f', '-print0'], { timeoutMs: 10_000 })
    if (t.top && run.exitCode !== 0) return null
    const paths = run.stdout.split('\0').filter(Boolean)
    if (run.isStdoutTruncated) paths.pop()
    return paths.map(p => (isAbsolute(p) ? p : join(t.root, p)))
  } catch {
    return null
  }
}

function indexPaths($: EngineInterface, s: Instance, t: FileTree): Promise<string[]> {
  if (s.searchIndex?.root !== t.root) {
    const index: { root: string; paths: Promise<string[]> } = {
      root: t.root,
      paths: listAll($, s, t).then(paths => {
        if (paths === null && s.searchIndex === index) s.searchIndex = null
        return paths ?? []
      }),
    }
    s.searchIndex = index
  }
  return s.searchIndex.paths
}

async function search($: EngineInterface, s: Instance, query: string): Promise<string[]> {
  if (!(await get($, s)).query.trim()) s.searchIndex = null
  await patch($, s, () => ({ query }))
  const q = query.trim().toLowerCase()
  if (!q) return []
  const t = await get($, s)
  const hits = (await indexPaths($, s, t)).filter(p => relative(t.root, p).toLowerCase().includes(q)).slice(0, SEARCH_REVEAL_LIMIT)
  if ((await get($, s)).query !== query) return []
  await revealPaths($, s, hits)
  const shown = await get($, s)
  const ids = new Set(shown.nodes.map(n => n.id))
  const stale = [...new Set(hits.filter(p => !ids.has(p)).map(dirname))].filter(d => inside(shown.root, d))
  if (stale.length) await loadDirs($, s, stale)
  return hits
}

async function jump($: EngineInterface, s: Instance, query: string): Promise<void> {
  const hits = (await search($, s, query)).slice(0, 10)
  await patch($, s, cur => {
    const open = new Set(cur.expanded)
    for (const p of hits) for (const a of ancestorsOf(p, cur.root)) open.add(a)
    return { query: '', expanded: [...open], cursor: hits[0] ?? cur.cursor, scroll: null }
  })
}

async function loadPreview($: EngineInterface, s: Instance, path: string): Promise<void> {
  let text = ''
  let note = ''
  try {
    const stat = await $.fs.stat(path)
    if (stat.size > 4_000_000) note = `${formatSize(stat.size)}, too large to preview`
    else {
      text = await $.fs.read(path)
      if (text.slice(0, 8000).includes('\0')) {
        text = ''
        note = `binary file, ${formatSize(stat.size)}`
      }
    }
  } catch (err) {
    note = `could not read: ${String((err as Error)?.message ?? err).split('\n')[0]}`
  }
  const total = text.length
  let lines = text.slice(0, PREVIEW_CHARS).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n')
  if (total > PREVIEW_CHARS && lines.length > 1) lines.pop()
  lines = lines.map(l => (l.length > PREVIEW_LINE ? `${l.slice(0, PREVIEW_LINE)}…` : l))
  const fit = fitSerialized(lines, PREVIEW_CHARS)
  if (total > PREVIEW_CHARS || fit.length < lines.length) note = `first ${fit.length.toLocaleString('en')} lines of ${total.toLocaleString('en')} characters`
  s.previewed = { path, text: fit.join('\n'), note }
}

async function closePreview($: EngineInterface, s: Instance): Promise<void> {
  await patch($, s, () => ({ preview: '', previewTop: 0 }))
}

async function scrollPreview($: EngineInterface, s: Instance, by: number): Promise<void> {
  const t = await get($, s)
  const last = Math.max(0, (s.previewed?.text.split('\n').length ?? 1) - s.previewRows)
  const top = Math.max(0, Math.min(last, t.previewTop + by))
  if (top !== t.previewTop) await patch($, s, () => ({ previewTop: top }))
}

async function toggle($: EngineInterface, s: Instance, n: FileNode): Promise<void> {
  if (n.kind === 'dir' && !(await get($, s)).expanded.includes(n.id)) await loadDirs($, s, [n.id])
  await patch($, s, t => {
    const open = new Set(t.expanded)
    if (n.kind === 'dir') open.has(n.id) ? open.delete(n.id) : open.add(n.id)
    // A folder shut forgets its unfolded stretches and its flat: it reopens folded.
    const shut = n.kind === 'dir' && !open.has(n.id)
    const fold = shut ? { unfold: t.unfold.filter(k => !k.startsWith(n.id + FOLD_KEY)), flat: t.flat.filter(d => d !== n.id) } : {}
    return { expanded: [...open], cursor: n.id, selected: n.kind === 'dir' ? t.selected : n.id, ...fold }
  })
}

// A click or enter on a fold row: its stretch shows, and the cursor lands on the stretch's first file.
async function unfold($: EngineInterface, s: Instance, key: string): Promise<void> {
  const first = key.slice(key.indexOf(FOLD_KEY) + 1)
  await patch($, s, t => ({ unfold: t.unfold.includes(key) ? t.unfold : [...t.unfold, key], cursor: first }))
}

async function toggleFlat($: EngineInterface, s: Instance, dir: string): Promise<void> {
  await patch($, s, t => ({ flat: t.flat.includes(dir) ? t.flat.filter(d => d !== dir) : [...t.flat, dir] }))
}

// A big folder open and not flat, with no filter choosing its rows: the one `right` shows whole.
function foldedDir(t: FileTree, n: FileNode): boolean {
  if (n.kind !== 'dir' || !t.expanded.includes(n.id) || t.flat.includes(n.id) || t.query.trim() || t.onlyChanged) return false
  return isBig(t.nodes.filter(k => k.parent === n.id && (t.showHidden || !k.hidden)), bigFolder)
}

// The tab never changes root, so opening a folder only expands it.
async function openNode($: EngineInterface, s: Instance, n: FileNode): Promise<void> {
  if (n.kind === 'dir') await toggle($, s, n)
  else await openFile($, n.id)
}

async function press($: EngineInterface, s: Instance, n: FileNode): Promise<void> {
  const now = await $.clock.now()
  const isDouble = lastPress.key === n.id && now - lastPress.at < DOUBLE_MS
  lastPress = { key: isDouble ? '' : n.id, at: now }
  if (!isDouble) {
    await toggle($, s, n)
    return
  }
  await openNode($, s, n)
}

async function onMessage($: EngineInterface, s: Instance, e: { element?: string; data?: unknown; surface?: string }) {
  const data = e.data as { press?: unknown; key?: unknown; ctrl?: unknown; shift?: unknown; scrollTo?: unknown; copy?: unknown; flat?: unknown }
  void sync($, s)
  const t = await get($, s)
  if (typeof data.copy === 'string') {
    await copyPath($, s, data.copy, Boolean(data.shift), e.surface)
    return
  }
  if (typeof data.scrollTo === 'number') {
    const to = Math.round(Math.max(0, Math.min(1, data.scrollTo)) * s.view.max)
    if (to !== t.scroll) await patch($, s, () => ({ scroll: to }))
    return
  }
  if (typeof data.flat === 'string') {
    await toggleFlat($, s, data.flat)
    return
  }
  if (typeof data.press === 'string') {
    if (data.press.includes(FOLD_KEY)) {
      if (t.scroll === null) await patch($, s, () => ({ scroll: s.view.from }))
      await unfold($, s, data.press)
      return
    }
    const n = t.nodes.find(x => x.id === data.press)
    if (!n) return
    if (t.scroll === null) await patch($, s, () => ({ scroll: s.view.from }))
    if (data.ctrl || data.shift) await openNode($, s, n)
    else await press($, s, n)
    return
  }
  if (typeof data.key !== 'string') return
  if (t.preview) {
    const page = Math.max(1, s.previewRows - 2)
    const by: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity }
    if (data.key === 'left' || data.key === 'h') await closePreview($, s)
    else if (data.key in by) await scrollPreview($, s, by[data.key] ?? 0)
    return
  }
  const rows = visibleRows(t, foldCtx(s, t))
  const at = rows.findIndex(r => r.node.id === t.cursor)
  const cur = rows[at]?.node
  const move = (d: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + d))]
    return target ? patch($, s, () => ({ cursor: target.node.id, scroll: null })) : Promise.resolve()
  }
  if (data.key === 'up' || data.key === 'k') await move(-1)
  else if (data.key === 'down' || data.key === 'j') await move(1)
  else if (data.key === 'pageup') await move(-10)
  else if (data.key === 'pagedown') await move(10)
  else if (data.key === 'home') await move(-rows.length)
  else if (data.key === 'end') await move(rows.length)
  else if (cur?.kind === 'fold') {
    if (data.key === 'return') await unfold($, s, cur.id)
    else if ((data.key === 'left' || data.key === 'h') && cur.parent !== t.root) await patch($, s, () => ({ cursor: cur.parent }))
  } else if (cur && (data.key === 'y' || data.key === 'Y')) await copyPath($, s, cur.id, data.key === 'Y' || Boolean(data.shift), e.surface)
  else if (cur && (data.key === 'right' || data.key === 'l') && cur.kind === 'dir' && !t.expanded.includes(cur.id)) await toggle($, s, cur)
  else if (cur && (data.key === 'right' || data.key === 'l') && foldedDir(t, cur)) await toggleFlat($, s, cur.id)
  else if (cur && (data.key === 'left' || data.key === 'h')) {
    if (cur.kind === 'dir' && t.expanded.includes(cur.id)) await toggle($, s, cur)
    else if (cur.parent !== t.root) await patch($, s, () => ({ cursor: cur.parent }))
  } else if (cur && data.key === 'return') await (cur.kind !== 'dir' ? openNode($, s, cur) : toggle($, s, cur))
  else if (cur && data.key === ' ') await toggle($, s, cur)
}

async function onScroll($: EngineInterface, s: Instance, by: number): Promise<boolean> {
  if (s.nativeScroll) return false
  const t = await get($, s)
  if (t.preview) {
    await scrollPreview($, s, Math.sign(by) * Math.max(3, Math.abs(by)))
    return true
  }
  const to = Math.max(0, Math.min(s.view.max, (t.scroll ?? s.view.from) + Math.sign(by) * Math.max(3, Math.abs(by))))
  if (to !== t.scroll) await patch($, s, () => ({ scroll: to }))
  return true
}

// Before the tool runs: the git chips and HEAD the outcome is checked against.
async function beforeBash($: EngineInterface, s: Instance, command: string): Promise<Pending | null> {
  const actions = gitActions(command)
  if (!actions.length) return null
  const head = actions.some(a => a.verb === 'commit') && (await get($, s)).top ? await headOf($, s) : ''
  return { actions, ids: await startGit($, s, actions), command, head }
}

// The files under a folder, depth levels down; null past BLIND_LIMIT entries, a folder that big is left to the scan.
async function filesUnder($: EngineInterface, s: Instance, dir: string, depth: number): Promise<Set<string> | null> {
  const out = new Set<string>()
  let seen = 0
  let level = [dir]
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = []
    for (const at of level) {
      for (const n of (await list($, s, at)) ?? []) {
        if (++seen > BLIND_LIMIT) return null
        if (n.kind !== 'dir') out.add(n.id)
        else if (!PRUNE.includes(n.name)) next.push(n.id)
      }
    }
    level = next
  }
  return out
}

// A folder a command writes into without naming the files (a loop's variable, a glob), listed before it runs.
type Snap = { dir: string; depth: number; files: Set<string> }

async function snapshot($: EngineInterface, s: Instance, blind: Blind[]): Promise<Snap[]> {
  const out: Snap[] = []
  for (const b of blind) {
    const dir = inRepo(s.repo, b.path)
    const files = dir ? await filesUnder($, s, dir, b.depth) : null
    if (dir && files) out.push({ dir, depth: b.depth, files })
  }
  return out
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// What came and went under those folders, born and gone, in the tree's order of names.
async function cameAndWent($: EngineInterface, s: Instance, snaps: Snap[]): Promise<[string, StepFile][]> {
  const out: [string, StepFile][] = []
  for (const snap of snaps) {
    const now = await filesUnder($, s, snap.dir, snap.depth)
    if (!now) continue
    for (const p of now) if (!snap.files.has(p)) out.push([p, { born: true }])
    for (const p of snap.files) if (!now.has(p)) out.push([p, { gone: true }])
  }
  return out.sort((a, b) => byName.compare(a[0], b[0]))
}

// Before the command: whether each path it names was there (removes: the ones it removes) and the folders it writes
// into without naming the files.
type Before = { existed: Map<string, boolean>; removes: Set<string>; snaps: Snap[] }

async function afterTool($: EngineInterface, s: Instance, pending: Pending | null, command: string, cwd: string, since: Since, result: ToolResult, ps: boolean, epoch: number, before?: Before): Promise<void> {
  if (pending && result.deny) {
    const ids = pending.ids
    await setActivities($, s, cur => cur.filter(a => !ids.includes(a.id)))
    await settlePulse($, s)
    return
  }
  if (result.deny) return
  const out: Partial<BuiltinToolResults['Bash']> = !result.isError && result.result && typeof result.result === 'object' ? (result.result as Partial<BuiltinToolResults['Bash']>) : {}
  // filetree's readTargets misses `wsl.exe sh -c`, PowerShell and quoted Windows paths; detect.ts reads those.
  const named = readTargets(command, cwd, typeof out.stdout === 'string' ? out.stdout : '', home)
  const parsed = shellReads(command, ps, home, cwd).map(t => t.path)
  const reads = showReads ? [...new Set([...named, ...parsed].flatMap(p => inRepo(s.repo, p) ?? []))] : []
  const quiet = !pending && readOnly(command)
  const names = namesOf(ps ? 'PowerShell' : 'Bash', command)
  const job: Job = { actions: [], since, initRepo: Boolean(pending?.actions.some(a => a.init)), readOnly: quiet || result.isReadOnly === true, epoch, ...(names.length ? { names } : {}) }
  if (out.backgroundTaskId) {
    s.background.set(out.backgroundTaskId, { p: pending, job, reads })
    return
  }
  // What the command named that was born or is gone now; an edit in place (sed -i, echo >) records nothing.
  const files: Record<string, StepFile> = {}
  if (before) {
    for (const [p, was] of before.existed) {
      const is = await exists($, p)
      if (was !== is && !result.isError) files[p] = is ? { born: true } : { gone: true }
      // The early light took the removal for done and the file is still there: its step is no deletion.
      else if (was && is && before.removes.has(p)) files[p] = { gone: false }
    }
    // Then what came and went where the command wrote without naming the files, up to FIND_LIMIT in all.
    if (!result.isError) for (const [p, f] of await cameAndWent($, s, before.snaps)) if (!(p in files) && Object.keys(files).length < FIND_LIMIT) files[p] = f
  }
  const results = pending ? await outcomes($, s, pending, !result.isError, out.gitOperation) : []
  if (pending) await finishGit($, s, pending, results)
  s.queuedReads.push(...reads)
  const done = gitOf(pending, results)
  scheduleScan($, s, { ...job, actions: proven(pending, results), ...(Object.keys(files).length ? { files } : {}), ...(done ? { git: done } : {}) })
}

async function failTool($: EngineInterface, s: Instance, pending: Pending | null): Promise<void> {
  if (pending) await finishGit($, s, pending, failAll(pending))
}

async function restart($: EngineInterface, s: Instance): Promise<void> {
  const t = await get($, s)
  stopLive(s)
  stopPulse(s)
  forgetLit(s)
  if (t.flashOn) await patch($, s, () => ({ flash: [], flashDim: [], flashOn: false, flashTones: {} }))
  if (t.preview) await patch($, s, () => ({ preview: '', previewTop: 0 }))
  await setActivities($, s, cur => cur.map(a => (a.state === 'running' ? { ...a, state: 'failed', label: `${a.kind} interrupted` } : a)))
  if (t.root !== s.repo.root || t.nodes.length === 0) await reset($, s)
  else void sync($, s, true)
}

function dispose(s: Instance): void {
  s.alive = false
  s.blink?.cancel()
  s.blink = null
  stopLive(s)
  stopPulse(s)
  forgetLit(s)
  s.generation += 1
}

async function render($: EngineInterface, s: Instance, e: RenderInput) {
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return null
  const props = e.props as { placement?: string; bodyColumns: number; scroll?: { bodyRows?: number } }
  if (e.surface === 'terminal' && props.placement === 'inline') {
    s.noDock = true
    void $.ui.close({ id: s.id }).catch(() => undefined)
    const { Box: Empty } = $.ui.resolve(e)
    return <Empty />
  }
  const unicode = glyphSetting === 'plain' || (glyphSetting === 'auto' && (noNerd || e.surface === 'desktop'))
  const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
  const t = await get($, s)
  const theme: Theme = (await $.state.get(THEME)).value ?? DEFAULT_THEME
  // The desktop tab never hands the wheel or the scrollbar drag to the pane, so
  // there it draws every row and lets the engine scroll the body.
  s.nativeScroll = e.surface === 'desktop'
  if (t.preview) {
    if (s.previewed?.path !== t.preview) await loadPreview($, s, t.preview)
    const p = s.previewed
    const markdown = /\.(md|markdown|mdx)$/i.test(t.preview)
    const all = (p?.text ?? '').split('\n').length
    s.previewRows = s.nativeScroll ? all : Math.max(4, (props.scroll?.bodyRows ?? 40) - (p?.note ? 2 : 1))
    const win = previewLines(p?.text ?? '', s.nativeScroll ? 0 : Math.min(t.previewTop, Math.max(0, all - s.previewRows)), s.previewRows, markdown)
    const name = t.preview !== t.root && inside(t.root, t.preview) ? relative(t.root, t.preview) : shortPath(t.preview)
    return (
      <Box flexDirection="column" minHeight={Math.max(1, props.scroll?.bodyRows ?? 1)} backgroundColor={theme.bg || undefined}>
        <Box flexDirection="row">
          <Button key="back" plain label={unicode ? '← files' : '\u{f004d} files'} onPress={() => void closePreview($, s)} />
          <Text> </Text>
          <Box flexShrink={1} flexGrow={1}>
            <Text bold wrap="truncate-start">{name}</Text>
          </Box>
          <Button key="external" plain dimColor label={unicode ? '↗' : '\u{f08e}'} onPress={() => void openFile($, t.preview)} />
        </Box>
        {p?.note ? <Text dimColor>{p.note}</Text> : null}
        <Client
          key="rows"
          module="./rows.tsx"
          props={{ rows: [], active: '', activeBg: theme.selection, hoverBg: faint(theme.selection), tones: SHIMMER, pointer: false, preview: { text: win.text, path: t.preview, startLine: win.top + 1, markdown } } satisfies RowsProps}
        />
      </Box>
    )
  }
  const now = await $.clock.now()
  const live = (await activities($, s)).filter(a => now - a.at < (a.state === 'running' ? RUNNING_MAX_MS : ACTIVITY_TTL_MS))
  const latest = [...live].reverse().find(a => a.state === 'running') ?? live[live.length - 1]
  const replayed = replayedGit(s.replay)
  // The live run of 2 files or more, while it plays: the one playing (or lit at once) of all queued since the queue was empty.
  const run = s.live && (s.live.step || s.live.queue.length) && s.live.run.total >= 2 ? s.live.run : null
  const runText = run ? `▸ ${Math.min(run.done, run.total)} of ${run.total}` : ''
  const bright =new Set(t.flashOn ? t.flash : [])
  const dimmed = new Set(t.flashOn ? t.flashDim : [])
  const ignored = new Set(t.ignored)
  const untracked = new Set(t.untrackedDirs)
  const width = Math.max(24, props.bodyColumns)
  // modern's replay draws from its own fields; the tree's flash stays dark while it plays.
  // The live light draws from its own the same way, one player at a time: each one stops the other.
  const rp: Player | null = s.live ?? (s.replay?.modern ? s.replay : null)
  // A file the replayed step removed: a struck row among its old siblings while the step plays.
  const { rows, ghosts, phantoms } = paneRows(s, t, s.live ?? s.replay)
  const counts = kidCounts(t)
  // Every row rides in the Client's props, bounded at 100,000 characters: past a few hundred the pane draws nothing, so a long list scrolls in a window like the terminal's.
  // A modern replay moves the window with its bar, so on the desktop it draws in its own window until it stops.
  // The live light only while its frames play: idle, its bar stays parked on its row and the desktop scrolls natively.
  const parked = s.live !== null && !s.live.step && !s.live.queue.length
  if (rows.length > NATIVE_ROWS || (rp && !parked)) s.nativeScroll = false
  const fixed = 2 + (t.top ? (t.branch ? 1 : 0) : 1) + (t.top && t.branch && (latest || replayed) ? 1 : 0) + (t.selected || runText ? 1 : 0)
  const ownRoom = Math.max(5, (props.scroll?.bodyRows ?? 40) - fixed)
  const room = s.nativeScroll ? Math.max(1, rows.length) : ownRoom
  const isLit = (x: string) => bright.has(x) || dimmed.has(x)
  const focus = followClaude && t.flashOn ? ([...t.flash].reverse().find(x => x !== BRANCH_ROW) ?? t.cursor) : t.cursor
  const at = Math.max(0, rows.findIndex(r => r.node.id === focus))
  const lit = followClaude && t.flashOn ? rows.findIndex(r => isLit(r.node.id)) : -1
  const cap = Math.max(1, Math.floor(room / 3))
  let from = Math.max(0, Math.min(lit >= 0 && at - lit < room - 2 ? Math.max(0, lit - 1) : at - Math.floor(room / 2), rows.length - room))
  let pinned = !s.nativeScroll && followClaude && t.flashOn ? rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap) : []
  if (pinned.length) {
    const rest = Math.max(3, room - pinned.length)
    from = Math.max(0, Math.min(at - Math.floor(rest / 2), rows.length - rest))
    pinned = rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap)
  }
  const max = Math.max(0, rows.length - room)
  if (t.scroll !== null) {
    from = Math.max(0, Math.min(t.scroll, max))
    pinned = []
  }
  s.view = { from, max, room: ownRoom }
  const shown = rows.slice(from, from + room - pinned.length)
  if (t.showSize) wantSizes($, s, [...pinned, ...shown].filter(r => r.node.kind === 'dir' && !(r.node.id in t.dirSizes)).map(r => r.node.id))
  // D7: while the replay counts, the top adds the count to git's total.
  const counting = Object.values(rp?.counts ?? {})
  const base = t.diff[t.root] ?? [0, 0]
  const totals: [number, number] = t.top ? [base[0] + counting.reduce((n, c) => n + c[0], 0), base[1] + counting.reduce((n, c) => n + c[1], 0)] : [0, 0]
  const countSegs = (c: [number, number, number] | undefined): Seg[] => {
    if (!c) return []
    const out: Seg[] = []
    if (c[0] > 0) out.push({ t: ` ?:${c[0]}`, c: GIT_COLOR['?'] ?? ADD_COLOR })
    if (c[1] > 0) out.push({ t: ` M:${c[1]}`, c: GIT_COLOR.M ?? '#e5c07b' })
    if (c[2] > 0) out.push({ t: ` D:${c[2]}`, c: theme.urgent })
    return out
  }
  const rootCounts = t.top ? countSegs(t.counts[t.root]) : []
  // The whole path, as the person would type it: C:\... on Windows, the Linux path in WSL.
  const header = s.repo.kind === 'wsl' ? `WSL ${s.repo.linux}` : s.repo.root.replace(/\//g, '\\')

  // modern: tone k of the row's ramp while it lights up or down, tone 2 once it settled.
  const rampFor = (id: string) => RAMPS[rp?.ramps[id] ?? ''] ?? RAMPS.teal!
  // The live light's rows keep their ramp for as long as their light is on: tone 2 lit, DIM_TONE on a folder on the way.
  const liveTone = (id: string): string | undefined => {
    const ramp = s.lit[id]
    if (!ramp || (rp && (rp.shade[id] || rp.settled[id]))) return undefined
    if (bright.has(id)) return (RAMPS[ramp] ?? RAMPS.teal!)[1]
    if (dimmed.has(id)) return (RAMPS[ramp] ?? RAMPS.teal!)[DIM_TONE]
    return undefined
  }
  const tint = (id: string): string | undefined => {
    if (!rp) return liveTone(id)
    const own = liveTone(id)
    if (own && !rp.shade[id] && !rp.settled[id]) return own
    const k = rp.shade[id]
    if (k) return rampFor(id)[k - 1]
    const done = rp.settled[id]
    return done ? (RAMPS[done] ?? RAMPS.teal!)[1] : undefined
  }
  // The step's icon takes the glyph's place, its tone cycling 5 4 3 4; an edit grows dots after the name.
  const iconAt = (id: string): { kind: Kind; frame: number } | null => (rp?.icon?.file === id ? rp.icon : null)
  const glyphOf = (kind: Kind) => (unicode ? ICONS[kind].plain : ICONS[kind].nerd) + ' '
  // Its frames over, the icon stays as a still mark in tone 3 of the row's ramp, with no dots.
  const markOf = (id: string): Seg | null => {
    const kind = rp?.marks[id]
    return kind ? { t: glyphOf(kind), c: rampFor(id)[2] } : null
  }
  const iconOf = (id: string): Seg | null => {
    const at = iconAt(id)
    if (!at) return markOf(id)
    return { t: glyphOf(at.kind), c: rampFor(id)[[5, 4, 3, 4][at.frame % 4]! - 1] }
  }
  const dotsOf = (id: string) => {
    const at = iconAt(id)
    return at?.kind === 'edit' ? ` ${'·'.repeat(Math.min(3, Math.ceil(at.frame / 3)))}` : ''
  }
  // A row the live light is playing draws its frames, even where an older light still shines on it.
  const playing = (id: string) => Boolean(rp && (rp.shade[id] || iconAt(id)))
  // Phase 13: the labels of the step's command as chips after the name, for as long as modern lights the row (its
  // tones up, its icon, its still mark, its settled tone, or the live light on it). The chip's background follows
  // the name's tone: tone k while it shades, the icon's 5 4 3 4 while it plays, tone 1 once settled, tone 2 lit.
  // Dark text from tone 3 up. Rounded caps ◖ ◗ in the tone, none in glyphs plain; 4 labels at most, then +N.
  const chipsOf = (id: string): Seg[] => {
    const labels = rp?.names[id]
    if (!rp || !labels?.length) return []
    // Only while the animation is on the row (its tones up and down, its icon): it leaves with the last tone down,
    // before the next row plays. Eduardo, 25/10: neither before the light comes nor after it moved on.
    const lit = Boolean(rp.shade[id] || iconAt(id))
    if (!lit) return []
    // The icon's cycle first: the shade stays at 5 under it.
    const at = iconAt(id)
    const k = at ? [5, 4, 3, 4][at.frame % 4]! - 1 : rp.shade[id] ? rp.shade[id]! - 1 : 0
    const bg = rampFor(id)[k]
    const text = k >= 2 ? '#1b1b1f' : theme.fg || undefined
    const out: Seg[] = []
    for (const label of labels.slice(0, 4)) {
      // Square, a space each side on the tone: the ◖ ◗ caps drew two cells wide on the desktop (24/10).
      out.push({ t: ' ' }, { t: ` ${label} `, c: text, bg })
    }
    if (labels.length > 4) out.push({ t: ` +${labels.length - 4}`, c: theme.muted })
    return clean(out)
  }
  // While modern plays every row gets a gutter column, as the mock's border: the bar's ▌ sits there,
  // in the row's tone, muted while it is unlit, and no caret is covered.
  const barBg = faint(theme.selection)
  const barred = (spec: RowSpec, id: string): RowSpec => {
    if (!rp) return spec
    if (rp.bar !== id) return { ...spec, left: [{ t: ' ' }, ...spec.left] }
    const k = rp.shade[id]
    return { ...spec, left: [{ t: '▌', c: k ? rampFor(id)[k - 1] : theme.muted }, ...spec.left], bg: barBg }
  }
  const rowSpec = (r: (typeof rows)[number]): RowSpec => {
    const n = r.node
    // id '' keeps the ghost out of clicks, copy and the cursor.
    if (ghosts.has(n.id)) {
      const c = tint(n.id) ?? theme.urgent
      return barred({ id: '', left: [{ t: '  '.repeat(r.depth) }, { t: '  ' }, iconOf(n.id) ?? { t: '· ', c }, { t: n.name, c, s: true }, ...chipsOf(n.id)], right: [] }, n.id)
    }
    // A hidden stretch of a folded folder: its count at the children's glyph column, nothing else.
    if (n.kind === 'fold') return barred({ id: n.id, left: [{ t: '  '.repeat(r.depth) }, { t: '  ' }, { t: `… ${enUS.format(r.count ?? 0)} files`, c: theme.muted }], right: [] }, n.id)
    // A file the replay made that the tree lost since: a plain row, out of clicks as a ghost.
    if (phantoms.has(n.id)) {
      const c = tint(n.id) ?? theme.fg
      const col = c ? { c } : {}
      return barred({ id: '', left: [{ t: '  '.repeat(r.depth) }, { t: '  ' }, iconOf(n.id) ?? { t: '· ', ...col }, { t: n.name, ...col }, ...chipsOf(n.id)], right: [] }, n.id)
    }
    const own = t.git[n.id]
    const status = own ?? (underAny(dirname(n.id), untracked, t.root) ? '?' : undefined)
    const isIgnored = !status && underAny(n.id, ignored, t.root)
    const gitColor = status === 'D' || status === 'U' ? theme.urgent : status ? (GIT_COLOR[status] ?? theme.muted) : undefined
    // Lit by the live light: the settled tone of its ramp, bold as a lit row, instead of the instant light's shimmer.
    const liveLit = bright.has(n.id) && !playing(n.id) && Boolean(s.lit[n.id])
    const liveDim = !bright.has(n.id) && dimmed.has(n.id) && !playing(n.id) && Boolean(s.lit[n.id])
    const isBright = bright.has(n.id) && !playing(n.id) && !liveLit
    const isDim = !isBright && dimmed.has(n.id) && !playing(n.id) && !liveDim
    const tone = t.flashTones[n.id] ?? 'orange'
    const iconColor = isIgnored ? theme.muted : (gitColor ?? (n.hidden ? theme.muted : n.kind === 'dir' ? theme.accent : theme.muted))
    const nameColor = isIgnored ? theme.muted : (gitColor ?? (n.hidden ? theme.muted : theme.fg || undefined))
    const counted = rp?.counts[n.id]
    const loc = counted ?? t.diff[n.id]
    const meta = t.showSize
      ? n.kind === 'dir'
        ? n.id in t.dirSizes
          ? formatSize(t.dirSizes[n.id] ?? -1)
          : '…'
        : n.kind === 'file' || (n.kind === 'link' && n.size > 0)
          ? formatSize(n.size)
          : ''
      : loc
        ? ''
        : n.kind === 'file'
          ? stamp(n.mtime)
          : ''
    // A side still at 0 of its count draws nothing yet, as in the mock.
    const adds = Boolean(loc && loc[0] > 0)
    const dels = Boolean(loc && loc[1] > 0)
    const locText = `${adds ? ` +${loc![0]}` : ''}${dels ? ` -${loc![1]}` : ''}`
    const dirCounts = n.kind === 'dir' ? countSegs(t.counts[n.id]) : []
    const badge = dirCounts.length ? '' : status ? ` ${status}` : isIgnored ? (unicode ? ' ⊘' : ' \u{f05e}') : '  '
    const countsText = dirCounts.map(c => c.t).join('')
    // A big folder's header carries its count after the name: the click target of flat, accent while it is flat.
    const total = n.kind === 'dir' && isBig({ length: counts.get(n.id) ?? 0 }, bigFolder) ? `·${enUS.format(counts.get(n.id) ?? 0)}` : ''
    const totalSeg: Seg[] = total ? [{ t: total, c: t.flat.includes(n.id) ? theme.accent : theme.muted, flat: n.id }] : []
    const cols = Math.max(4, width - r.depth * 2 - 6 - (rp ? 1 : 0) - (meta ? meta.length + 1 : 0) - locText.length - badge.length - countsText.length - total.length)
    const name = n.name.length > cols ? n.name.slice(0, cols - 1) + '…' : n.name
    const caret = n.kind === 'dir' ? (unicode ? (r.open ? '▾' : '▸') : r.open ? CHEVRON_OPEN : CHEVRON_CLOSED) + ' ' : '  '
    const isRepo = n.kind === 'dir' && n.id === t.top
    const glyph = unicode ? (n.kind === 'dir' ? '■' : '·') : fileIcon(n, r.open, isRepo)
    const isLitRow = isBright || isDim
    const tinted = tint(n.id)
    const left: Seg[] = [
      { t: '  '.repeat(r.depth) },
      { t: caret, c: theme.muted },
      // A lit row keeps its live mark while it is bright; dimmed, it shows none.
      isLitRow ? ((isBright ? markOf(n.id) : null) ?? { t: glyph + ' ', sh: tone, dim: isDim, one: true }) : (iconOf(n.id) ?? { t: glyph + ' ', c: tinted ?? iconColor }),
      isLitRow ? { t: name, sh: tone, dim: isDim, b: isBright } : { t: name + dotsOf(n.id), c: tinted ?? nameColor, b: n.id === t.selected || liveLit || liveDim, s: status === 'D' && n.kind !== 'dir' },
      ...totalSeg,
      // The chips come after the name, in the box the right side cuts: the name never shortens for them (cols stays).
      ...(n.kind === 'dir' ? [] : chipsOf(n.id)),
    ]
    const right: Seg[] = []
    if (meta) right.push({ t: ` ${meta}`, c: theme.muted })
    // The replay's own count in the mock's colors.
    if (adds) right.push({ t: ` +${loc![0]}`, c: counted ? RAMPS.green![3] : ADD_COLOR })
    if (dels) right.push({ t: ` -${loc![1]}`, c: counted ? RAMPS.red![3] : DEL_COLOR })
    right.push(...dirCounts)
    if (badge) right.push({ t: badge, c: status ? gitColor : theme.muted, b: true })
    return barred({ id: n.id, left: clean(left), right: clean(right) }, n.id)
  }

  const note = (text: string): RowSpec => ({ id: '', left: [{ t: text, c: theme.muted }], right: [] })
  const specs: RowSpec[] = [
    ...(rows.length === 0 ? [note(t.nodes.length === 0 ? 'loading…' : 'empty')] : []),
    ...pinned.map(rowSpec),
    ...(pinned.length > 0 ? [note('  ⋮')] : []),
    ...shown.map(rowSpec),
  ]
  const barSize = Math.max(1, Math.round((specs.length * shown.length) / Math.max(1, rows.length)))
  const bar =
    !s.nativeScroll && rows.length > shown.length + pinned.length
      ? { pos: max ? Math.round((from / max) * (specs.length - barSize)) : 0, size: barSize, thumb: theme.accent, track: theme.muted }
      : undefined

  const branchRow = () => {
    if (!t.top || !t.branch) return null
    const b = t.branch
    const isFlash = bright.has(BRANCH_ROW)
    const tone = t.flashTones[BRANCH_ROW] ?? 'teal'
    // modern: the commit's step tones the branch as it does a file, and its command's chips follow the head.
    const tinted = tint(BRANCH_ROW)
    const branchChips = chipsOf(BRANCH_ROW)
    // The pulse of the running action, under the live step's tint when the two meet.
    const pulse = s.pulse && latest?.state === 'running' ? (RAMPS[latest.tone] ?? RAMPS.teal!)[PULSE_TONES[s.pulse.frame % 4]!] : undefined
    const name = tinted ?? pulse
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" height={1} overflow="hidden">
          <Box flexDirection="row" flexShrink={0}>
            <Text color={name ?? (isFlash ? (TONES[tone]?.solid ?? theme.accent) : theme.accent)}>{(unicode ? BRANCH_ICON.plain : BRANCH_ICON.nerd) + ' '}</Text>
            <Text bold color={name ?? (isFlash ? (TONES[tone]?.solid ?? (theme.fg || undefined)) : theme.fg || undefined)}>
              {b.head}
            </Text>
            {b.ahead > 0 && <Text color={TONES.teal?.solid}>{` ↑${b.ahead}`}</Text>}
            {b.behind > 0 && <Text color={TONES.blue?.solid}>{` ↓${b.behind}`}</Text>}
          </Box>
          {branchChips.length > 0 && (
            <Box flexDirection="row" flexShrink={1} overflow="hidden">
              {branchChips.map(c => (
                <Text color={c.c} backgroundColor={c.bg}>
                  {c.t}
                </Text>
              ))}
            </Box>
          )}
          {b.upstream && (
            <Box flexShrink={1} overflow="hidden">
              <Text color={theme.muted} wrap="truncate-end">
                {` ${b.upstream}`}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} />
          <Box flexDirection="row" flexShrink={0}>
            {totals[0] > 0 && <Text color={ADD_COLOR}>{` +${totals[0]}`}</Text>}
            {totals[1] > 0 && <Text color={DEL_COLOR}>{` -${totals[1]}`}</Text>}
            {rootCounts.map(c => (
              <Text color={c.c}>{c.t}</Text>
            ))}
            {rootCounts.length === 0 && totals[0] === 0 && totals[1] === 0 && <Text color={theme.muted}> clean</Text>}
          </Box>
        </Box>
        {(replayed || latest) && (
          <Box flexDirection="row" height={1} overflow="hidden">
            <Text>{'  '}</Text>
            {replayed ? chip(replayed.a, replayed.bg) : chip(latest!, pulse)}
          </Box>
        )}
      </Box>
    )
  }

  // The git activity chip on the line under the branch row: on the pulse's tone while it runs, dark text as chipsOf from tone 3 up.
  const chip = (a: Activity, bg?: string) => {
    const tone = a.state === 'failed' ? 'red' : a.tone
    const color = bg ? '#1b1b1f' : (TONES[tone]?.solid ?? theme.accent)
    const icon = unicode ? a.plain : a.nerd
    const hash = a.state === 'done' && a.kind === 'git commit' ? a.detail.split(' ')[0] ?? '' : ''
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text color={color} backgroundColor={bg}>{(bg ? ' ' : '') + icon + ' '}</Text>
        <Text bold={a.state === 'running'} color={color} backgroundColor={bg}>
          {(a.state === 'running' ? `${a.label}…` : a.label) + (bg ? ' ' : '')}
        </Text>
        {hash && <Text color={theme.muted}>{` ${hash}`}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" minHeight={Math.max(1, props.scroll?.bodyRows ?? 1)} backgroundColor={theme.bg || undefined}>
      <Box flexDirection="row">
        <Text bold color={theme.accent} wrap="truncate-start">
          {header}
        </Text>
        <Box flexGrow={1} />
        <Box flexDirection="row" gap={2}>
          {replayAnimation === 'modern' && (
            <Button
              key="speed"
              plain
              dimColor={speed === 1}
              label={`${speed}x`}
              onPress={() => {
                speed = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!
                void patch($, s, cur => ({ tick: cur.tick + 1 }))
              }}
            />
          )}
          {s.replay && <Button key="replay-stop" plain label={`■ ${s.replay.index}/${s.replay.total}`} onPress={() => void stopReplay($, s)} />}
          {!s.replay && s.trail.length > 0 && (stepsFor(s.trail, 'last', turn).length > 0 ? <Button key="replay-last" plain dimColor label="▷" onPress={() => void play($, s, 'last')} /> : <Text color={theme.muted} dimColor>▷</Text>)}
          {!s.replay && s.trail.length > 0 && <Button key="replay-all" plain dimColor label="▷▷" onPress={() => void play($, s, 'all')} />}
          <Button
            key="refresh"
            plain
            dimColor
            label={unicode ? '↻' : '\u{f0450}'}
            onPress={() =>
              void (async () => {
                const cur = await get($, s)
                s.searchIndex = null
                await staleSizes($, s)
                await loadDirs($, s, [cur.root, ...cur.expanded])
                await detectRepo($, s)
                await refreshGit($, s)
                if (cur.query.trim()) await search($, s, cur.query)
              })()
            }
          />
          <Button
            key="hidden"
            plain
            dimColor={!t.showHidden}
            label={unicode ? (t.showHidden ? '◉' : '○') : t.showHidden ? '\u{f0208}' : '\u{f0209}'}
            onPress={() => void patch($, s, cur => ({ showHidden: !cur.showHidden }))}
          />
          <Button
            key="changed"
            plain
            dimColor={!t.onlyChanged}
            label={t.onlyChanged ? '± changed only' : '±'}
            onPress={() =>
              void (async () => {
                const on = !(await get($, s)).onlyChanged
                await patch($, s, () => ({ onlyChanged: on, scroll: null }))
                if (on) await revealChanged($, s)
              })()
            }
          />
          <Button
            key="size"
            plain
            dimColor={!t.showSize}
            label={unicode ? 'Σ' : '\u{f02ca}'}
            onPress={() => void patch($, s, cur => ({ showSize: !cur.showSize }))}
          />
          <Button key="collapse" plain dimColor label={unicode ? '⊟' : '\u{eac5}'} onPress={() => void patch($, s, cur => ({ expanded: [], nodes: dropBelow(cur.nodes, cur.nodes.filter(x => x.parent === cur.root && x.kind === 'dir').map(x => x.id)) }))} />
          {t.selected && (
            <Button key="unselect" plain label={unicode ? '⊘' : '\u{f0777}'} onPress={() => void patch($, s, () => ({ selected: '' }))} />
          )}
          <Text> </Text>
        </Box>
      </Box>
      {branchRow()}
      {!t.top && <Text color={theme.muted}>{unicode ? '± ' : '\u{e702} '}{t.nodes.length === 0 ? 'reading git…' : 'no git s.repo'}</Text>}
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Input
            key="q"
            label="/ "
            placeholder="search"
            submitLabel="jump"
            value={t.query}
            onInput={(v: string) => void search($, s, v)}
            onSubmit={(v: string) => void jump($, s, v)}
          />
        </Box>
        {t.query ? <Button key="clear" plain dimColor label={unicode ? '×' : '\u{f0156}'} onPress={() => void search($, s, '')} /> : null}
      </Box>
      <Client
        key="rows"
        module="./rows.tsx"
        props={{ rows: specs, active: t.cursor, activeBg: theme.selection, hoverBg: faint(theme.selection), tones: SHIMMER, pointer, ...(bar ? { bar } : {}) } satisfies RowsProps}
      />
      <Box flexGrow={1} />
      {(t.selected || runText) && (
        <Box flexDirection="row">
          {t.selected ? (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-start">
                selected: {t.selected !== t.root && inside(t.root, t.selected) ? t.selected.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : shortPath(t.selected)}
              </Text>
            </Box>
          ) : null}
          <Box flexGrow={1} />
          {runText && (
            <Box flexDirection="row" marginLeft={2} flexShrink={0}>
              <Text color={theme.muted}>{runText}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}


async function repos($: EngineInterface): Promise<Record<string, Repo>> {
  return (await $.state.get(REPOS)).value ?? {}
}

// A reload starts the module over while its panes stay up; the registry in $.state rebuilds them.
async function instanceFor($: EngineInterface, requestId: string): Promise<Instance | null> {
  const known = instances.get(requestId)
  if (known) return known
  const repo = (await repos($))[requestId]
  if (!repo) return null
  const made = makeInstance(repo)
  instances.set(made.id, made)
  await revive($, made)
  return made
}

// After a reload: the trail comes back from $.state, and the counters go on past what it holds.
async function revive($: EngineInterface, s: Instance): Promise<void> {
  turn = Math.max(turn, (await $.state.get(TURN)).value ?? 0)
  const saved = (await $.state.get({ ...TRAIL, id: s.id })).value ?? []
  if (s.trail.length === 0) s.trail = saved
  for (const one of saved) lightEpoch = Math.max(lightEpoch, one.epoch)
}

async function openRepo($: EngineInterface, repo: Repo, focus: boolean) {
  const id = paneId(repo.key)
  await update($, REPOS, cur => ({ ...(cur ?? {}), [id]: repo }))
  const existing = instances.get(id)
  if (existing) return { inst: existing, opened: await $.ui.open({ id, title: titleOf(repo), ...(focus ? { focus: true } : {}) }) }
  const inst = makeInstance(repo)
  instances.set(id, inst)
  return { inst, opened: await reset($, inst, focus) }
}

async function closeRepo($: EngineInterface, id: string): Promise<void> {
  const gone = instances.get(id)
  if (gone) dispose(gone)
  instances.delete(id)
  await update($, REPOS, cur => {
    const next = { ...(cur ?? {}) }
    delete next[id]
    return next
  })
}

function findRepo(all: Record<string, Repo>, arg: string): string | null {
  const q = arg.trim().replace(/^["']|["']$/g, '').toLowerCase()
  for (const [id, r] of Object.entries(all)) {
    if (id.toLowerCase() === q || r.key.toLowerCase() === q || r.root.toLowerCase() === q || r.linux.toLowerCase() === q) return id
    if (r.root.split('/').pop()?.toLowerCase() === q) return id
    if (inRepo(r, arg.trim())) return id
  }
  return null
}

function seen(e: RenderInput): void {
  const v = (e as { viewport?: { columns: number; isFullscreen?: boolean } }).viewport
  if (v) views.set(e.surface, { columns: v.columns, ...(v.isFullscreen === undefined ? {} : { isFullscreen: v.isFullscreen }) })
}

function commandOf(e: { tool: string }): string {
  const c = (e as { command?: unknown }).command
  return (e.tool === 'Bash' || e.tool === 'PowerShell') && typeof c === 'string' ? c : ''
}

function fileOf(e: object): string {
  if ('file_path' in e && typeof e.file_path === 'string') return e.file_path
  if ('notebook_path' in e && typeof e.notebook_path === 'string') return e.notebook_path
  return ''
}

const USAGE = 'usage: /trail [open <folder> | close <root> | forget <root | all>]'

// A plain reopen is tried first so the prompt keeps the keyboard; focus is the fallback.
async function bringToFront($: EngineInterface, s: Instance): Promise<void> {
  if (!tabFollows) return
  const shown = async () => (await $.ui.panes()).find(p => p.id === s.id)
  const before = await shown()
  if (!before || before.isShown) {
    diag($, `trail: ${s.id} ${before ? 'already in front' : 'not in ui.panes'}`)
    return
  }
  await openPane($, s).catch(() => undefined)
  if ((await shown())?.isShown) return void diag($, `trail: ${s.id} switched without focus`)
  const r = await openPane($, s, true).catch((err: unknown) => ({ isPlaced: false, reason: String(err) }))
  diag($, `trail: ${s.id} with focus: ${(await shown())?.isShown ? 'switched' : 'did not switch'} ${JSON.stringify(r)}`)
}

// The gray diagnostic line of phase 1, now behind the `diagnostics` option.
function diag($: EngineInterface, text: string): void {
  $.ui.log(text, diagnose ? undefined : { to: 'debug' })
}

function repoList(v: unknown): Repo[] {
  return Array.isArray(v) ? v.filter((r): r is Repo => Boolean(r) && typeof r === 'object' && typeof (r as Repo).key === 'string') : []
}

async function remembered($: EngineInterface): Promise<Repo[]> {
  return repoList(await $.store.get(REMEMBERED).catch(() => []))
}

async function remember($: EngineInterface, repo: Repo): Promise<void> {
  const list = await remembered($)
  if (!list.some(r => r.key === repo.key)) await $.store.set(REMEMBERED, [...list, repo])
}

async function quiet($: EngineInterface): Promise<Repo[]> {
  return (await $.state.get(QUIET)).value ?? []
}

async function hush($: EngineInterface, repo: Repo, on: boolean): Promise<void> {
  await update($, QUIET, cur => [...(cur ?? []).filter(r => r.key !== repo.key), ...(on ? [repo] : [])])
}

// Once per session, so a hot reload does not reopen a tab the person closed.
async function openSessionTab($: EngineInterface, cwd: string): Promise<void> {
  if (!sessionTab || (await $.state.get(SESSION_TAB_DONE)).value) return
  await $.state.set(SESSION_TAB_DONE, true)
  const found = await resolveRepo($, cwd, cwd)
  if ('error' in found) return
  const id = paneId(found.repo.key)
  if (instances.has(id)) return
  await openRepo($, found.repo, false)
}

async function pause($: EngineInterface): Promise<void> {
  for (;;) {
    try {
      const run = await $.process.run(PAUSES[pauseAt] ?? [], { timeoutMs: 5_000 })
      if (run.exitCode === 0) return
    } catch {
      // not installed here
    }
    if (pauseAt >= PAUSES.length - 1) throw new Error('trail cannot wait: node, ping and sleep all failed')
    pauseAt += 1
  }
}

// The value if it settles within `ms`, else undefined and the promise keeps running.
async function within<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T | undefined> {
  let done = false
  let value: T | undefined
  void p.then(
    v => {
      done = true
      value = v
    },
    () => {
      done = true
    },
  )
  const until = (await $.clock.now()) + ms
  while (!done && (await $.clock.now()) < until) await pause($)
  return done ? value : undefined
}

async function rootOf($: EngineInterface, t: Target): Promise<Repo | null> {
  const key = `${t.wsl ? 'wsl' : 'win'}|${t.path}`
  const now = await $.clock.now()
  const hit = roots.get(key)
  if (hit && (hit.repo || now - hit.at < NO_ROOT_TTL_MS)) return hit.repo
  const found = await resolveRepo($, t.path, startCwd || (await cwdOf($)), true)
  const repo = 'error' in found ? null : found.repo
  roots.set(key, { repo, at: now })
  return repo
}

// No room for a tab (the terminal inline or under 110 columns): the mod stays quiet, as filetree does.
async function muted($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  if (!surfaces.length) return true
  if (surfaces.some(s => s !== 'terminal')) return false
  const v = views.get('terminal')
  // Only the main screen has nowhere to dock a tab. The columns are the chat's, which shrink once a tab docks
  // beside it; a terminal too narrow for a new tab answers isPlaced false, and the card then draws above the prompt.
  return v ? v.isFullscreen === false : false
}

async function showCard($: EngineInterface, card: Card) {
  const opened = await $.ui.open({ id: CARD_ID, title: 'External repo', focus: true, rows: CARD_ROWS })
  // Focus is only a request: a pane the person holds keeps the front, and the card would wait as a tab behind it.
  const pane = opened.isPlaced ? (await $.ui.panes().catch(() => [])).find(p => p.id === CARD_ID) : undefined
  card.where = pane?.isShown ? 'pane' : 'band'
  $.ui.invalidate('ui.render')
  return opened
}

async function ask($: EngineInterface, e: { tool: string }, signal: AbortSignal, t: Target, what: string, folder: string): Promise<{ deny: string } | null> {
  while (held) {
    if (signal.aborted) return { deny: 'trail: the call was interrupted while another card was waiting for an answer.' }
    await pause($)
  }
  const card: Card = { tool: e.tool, what, folder, root: null, title: '', decision: null, where: 'pane' }
  held = card
  let shown = false
  let repo: Repo | null | undefined
  try {
    const resolving = rootOf($, t)
    repo = await within($, resolving, EARLY_MS)
    if (repo === undefined) {
      shown = true
      await showCard($, card)
      repo = await resolving
    }
    // The tab may have opened while this call waited behind another card.
    if (!repo || instances.has(paneId(repo.key)) || (await quiet($)).some(r => r.key === repo?.key)) return null
    if ((await remembered($)).some(r => r.key === repo?.key)) {
      card.decision = 'allow'
      return null
    }
    card.root = shortPath(repo.root)
    card.title = titleOf(repo)
    if (!shown) {
      shown = true
      await showCard($, card)
    } else $.ui.invalidate('ui.render')
    const startedAt = await $.clock.now()
    while (card.decision === null) {
      if (signal.aborted) card.decision = 'interrupted'
      else if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) card.decision = 'timeout'
      else await pause($)
    }
  } catch {
    card.decision = 'error'
  } finally {
    if (shown) await $.ui.close({ id: CARD_ID }).catch(() => undefined)
    if (held === card) held = null
    $.ui.invalidate('ui.render')
  }
  const root = repo ? repo.root : t.path
  if (repo && (card.decision === 'allow' || card.decision === 'always')) {
    if (card.decision === 'always') await remember($, repo)
    // Without the keys: a tab holding them refuses the next card's focus, and that card waits unseen behind it.
    await openRepo($, repo, false)
    return null
  }
  const why: Record<string, string> = {
    cancel: 'denied on the card',
    timeout: 'denied: no answer in 10 minutes',
    interrupted: 'denied: the call was interrupted',
    error: 'denied: trail failed while holding the call',
  }
  return { deny: `trail: access to ${root} ${why[card.decision ?? 'error'] ?? why.error}` }
}

// Before the call runs: a tab for each git repo it touches that has none yet, or with opening card a card for
// each repo outside the session.
async function gate($: EngineInterface, e: { tool: string } & Record<string, unknown>, signal: AbortSignal): Promise<{ deny: string } | null> {
  const targets = writeTargets(e, home, readsToo)
  if (!targets.length) return null
  const covered = (t: Target) => [...instances.values()].some(inst => inRepo(inst.repo, t.path))
  if (opening === 'auto') {
    if (await muted($)) return null
    // The session's repo too, and a tab the person closed comes back: never a card, never a deny.
    for (const t of targets) {
      if (covered(t)) continue
      const repo = await rootOf($, t)
      if (!repo || instances.has(paneId(repo.key))) continue
      await openRepo($, repo, false)
    }
    return null
  }
  const dirs = [startCwd, posix(await $.session.root().catch(() => ''))]
  const silent = await quiet($)
  const outside = targets.filter(t => !insideSession(t, dirs) && !covered(t) && !silent.some(r => inRepo(r, t.path)))
  if (!outside.length || (await muted($))) return null
  // A remembered repo opens its tab with no card and no wait on git.
  const known = await remembered($)
  const what = typeof e.command === 'string' ? e.command.replace(/\s+/g, ' ').slice(0, 300) : fileOf(e)
  for (const t of outside) {
    if (covered(t)) continue
    const mine = known.find(r => inRepo(r, t.path))
    if (mine) {
      await openRepo($, mine, false)
      continue
    }
    const folder = typeof e.command === 'string' ? t.path : t.path.replace(/[\\/][^\\/]*$/, '')
    const denied = await ask($, e, signal, t, what, folder)
    if (denied) return denied
  }
  return null
}

export const register: Register = (on, options) => {
  tabFollows = options?.followTab !== 'off'
  sessionTab = options?.sessionTab !== 'off'
  readsToo = options?.reads !== 'no'
  diagnose = options?.diagnostics === 'on'
  replayAnimation = options?.replayAnimation === 'classic' ? 'classic' : 'modern'
  liveAnimation = options?.liveAnimation === 'instant' ? 'instant' : 'animated'
  opening = options?.opening === 'card' ? 'card' : 'auto'
  const big = parseInt(String(options?.bigFolder ?? ''), 10)
  bigFolder = Number.isInteger(big) && big >= 0 ? big : 200
  glyphSetting = typeof options?.glyphs === 'string' ? options.glyphs : 'auto'
  sizeDefault = options?.column === 'size'
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'trail', description: 'File tree tabs per git repo, the session\'s and outside ones; args: [open <folder> | close <root> | forget <root | all>]' })
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    useDrives(windows)
    startCwd = (await $.state.get(START_CWD)).value || posix(e.cwd)
    await $.state.set(START_CWD, startCwd)
    home = posix(((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, ''))
    void (async () => {
      pointer = await finePointerOk($)
      const remote = Boolean((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY')))
      noNerd = !remote && windows
      await loadTheme($)
      themePoll?.cancel()
      themePoll = themeMtime ? $.clock.every(THEME_POLL_MS, () => void loadTheme($)) : null
      const open = new Set((await $.ui.panes()).map(p => p.id))
      for (const [id, repo] of Object.entries(await repos($))) {
        if (!open.has(id)) {
          await closeRepo($, id)
          continue
        }
        const inst = instances.get(id) ?? makeInstance(repo)
        instances.set(id, inst)
        await revive($, inst)
        await restart($, inst)
      }
      await openSessionTab($, e.cwd)
    })()
    return next(e)
  })

  on('command.run', { command: 'trail' }, async ($, e) => {
    const [verb = '', ...rest] = (e.args ?? '').trim().split(/\s+/)
    const arg = rest.join(' ')
    if (!verb) {
      const list = Object.values(await repos($))
      const kept = await remembered($)
      const hushed = await quiet($)
      const block = (head: string, rs: Repo[]) => (rs.length ? [head, ...rs.map(r => `  ${titleOf(r)}  ${r.key}`)] : [])
      const lines = [...block('Open tabs:', list), ...block("No card (don't ask again):", kept), ...block('Quiet this session (tab closed by hand):', hushed)]
      // What the gate decides by, so a write that passed with no card can be explained from the screen.
      const v = views.get('terminal')
      const surfaces = await $.session.surfaces().catch(() => [] as const)
      lines.push(
        `Session: ${startCwd || '?'} · root: ${posix(await $.session.root().catch(() => '')) || '?'}`,
        `Screen: ${surfaces.join(', ') || 'none'}${v ? ` · ${v.columns} columns · fullscreen ${v.isFullscreen === undefined ? '?' : v.isFullscreen ? 'yes' : 'no'}` : ''} · muted: ${(await muted($)) ? 'yes' : 'no'}`,
      )
      return { text: lines.length ? lines.join('\n') : `No tab open. ${USAGE}` }
    }
    if (verb === 'forget') {
      const kept = await remembered($)
      if (arg.trim() === 'all') {
        await $.store.set(REMEMBERED, [])
        return { text: kept.length ? `Forgot ${kept.length} repo(s): the card comes back for all of them.` : 'No repo remembered.' }
      }
      const q = arg.trim().replace(/^["']|["']$/g, '').toLowerCase()
      const gone = q ? kept.filter(r => r.key.toLowerCase() === q || r.root.toLowerCase() === q || r.linux.toLowerCase() === q || r.root.split('/').pop()?.toLowerCase() === q || inRepo(r, arg.trim())) : []
      if (!gone.length) return { text: `No repo remembered for ${arg || '(empty)'}. ${USAGE}` }
      await $.store.set(REMEMBERED, kept.filter(r => !gone.includes(r)))
      return { text: `Forgot ${gone.map(titleOf).join(', ')}: the card comes back on the next write.` }
    }
    if (verb === 'open') {
      // The layout checks are the terminal's: the desktop app docks the pane itself.
      const terminal = await $.session.surfaces().then(s => s.includes('terminal'), () => true)
      if (terminal && !e.presentation.isFullscreen) return { text: 'trail shows the tab on the side, which needs the fullscreen layout. Run /tui fullscreen and then /trail open.' }
      if (terminal && e.presentation.columns < 110) return { text: 'trail shows the tab on the side, which needs a terminal of at least 110 columns.' }
      const t0 = await $.clock.now()
      const found = await resolveRepo($, arg, await cwdOf($))
      if ('error' in found) return { text: `Did not open: ${found.error}.` }
      await hush($, found.repo, false)
      const { inst, opened } = await openRepo($, found.repo, true)
      const ms = Math.round((await $.clock.now()) - t0)
      const nodes = (await get($, inst)).nodes.length
      const placed = opened && !opened.isPlaced ? ` Tab not drawn yet: ${(opened as { reason?: string }).reason ?? 'no reason given'}.` : ''
      return { text: `Tab ${titleOf(found.repo)} at ${shortPath(found.repo.root)} (${nodes} items at the root, ${ms} ms to the tree and git).${placed}` }
    }
    if (verb === 'close') {
      const id = findRepo(await repos($), arg)
      if (!id) return { text: `No tab for ${arg || '(empty)'}. ${USAGE}` }
      await $.ui.close({ id }).catch(() => undefined)
      await closeRepo($, id)
      return { text: 'Tab closed.' }
    }
    return { text: USAGE }
  })

  on('tool.call', async ($, e, next) => {
    const denied = await gate($, e as { tool: string } & Record<string, unknown>, next.signal)
    if (denied) return denied
    // Calls sent together light together; the first of a new command puts out the last one's light.
    waiting = false
    if (inFlight === 0) {
      lightEpoch += 1
      for (const inst of instances.values()) await unlight($, inst)
    }
    const epoch = lightEpoch
    inFlight += 1
    try {
      const command = commandOf(e)
      const file = command ? '' : e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'Read' ? fileOf(e) : ''
      // Relative paths land in the session's folder, as the shell runs them.
      const here = command ? (await cwdOf($).catch(() => '')) || null : null
      const aimed = command ? shellWrites(command, e.tool === 'PowerShell', home, false, true, here).map(t => t.path) : file ? [file] : []
      const touches = (inst: Instance) => aimed.some(p => inRepo(inst.repo, p)) || Boolean(command && mentions(inst.repo, command))
      // One pane to the front per batch of calls, before the light: the repo with most paths, the last aimed on a tie.
      if (raisedEpoch !== epoch) {
        const score = (inst: Instance) => [aimed.filter(p => inRepo(inst.repo, p)).length || (touches(inst) ? 1 : 0), aimed.map(p => Boolean(inRepo(inst.repo, p))).lastIndexOf(true)] as const
        const pick = [...instances.values()].filter(touches).sort((a, b) => score(b)[0] - score(a)[0] || score(b)[1] - score(a)[1])[0]
        if (pick) {
          raisedEpoch = epoch
          void bringToFront($, pick)
        }
      }
      void lightEarly($, e, epoch, here)
      if (!instances.size || (!command && !file)) return await next(e)
      if (file) {
        // What the write did, for the replay: lines gained and lost, and whether the file was born.
        const writes = e.tool !== 'Read' && [...instances.values()].some(inst => inRepo(inst.repo, file))
        const existed = writes && (await exists($, file))
        const before = writes && existed && e.tool === 'Write' ? await $.fs.read(file).catch(() => '') : ''
        const result = await next(e)
        if (result.deny || result.isError) return result
        const tone = e.tool === 'Read' ? 'purple' : 'orange'
        let info: StepFile | null = null
        if (writes) {
          const args = e as Record<string, unknown>
          const text = [args.new_string, args.content, args.new_source].find(x => typeof x === 'string') ?? ''
          const old = typeof args.old_string === 'string' ? args.old_string : String(before)
          const after = await exists($, file)
          const [added, removed] = lineDelta(old, text)
          info = { added, removed, born: !existed && after, gone: existed && !after }
        }
        for (const inst of instances.values()) {
          const p = inRepo(inst.repo, file)
          if (!p) continue
          void touched($, inst, [p], tone, tone === 'purple' ? showReads : showWrites, epoch, info ? { [p]: info } : undefined, namesOf(e.tool, ''))
        }
        return result
      }
      const hit = [...instances.values()].filter(touches)
      if (!hit.length) return await next(e)
      const cwd = await cwdOf($)
      const since = await sinceNow($)
      const pending = await Promise.all(hit.map(inst => beforeBash($, inst, command)))
      // Whether each path the command writes to was there before it ran, per repo, in the tree's own form; and the
      // files under each folder it writes into without naming them (a loop's variable, a glob), to diff after it.
      const named = shellWrites(command, e.tool === 'PowerShell', home, false, false, here).slice(0, FIND_LIMIT)
      const blind = shellBlind(command, e.tool === 'PowerShell', home, here)
      const prior: Before[] = await Promise.all(
        hit.map(async inst => {
          const mine = named.flatMap(t => {
            const p = inRepo(inst.repo, t.path)
            return p && p !== inst.repo.root ? [{ p, gone: Boolean(t.gone) }] : []
          })
          const paths = [...new Set(mine.map(x => x.p))]
          return {
            existed: new Map(await Promise.all(paths.map(async p => [p, await exists($, p)] as const))),
            removes: new Set(mine.filter(x => x.gone).map(x => x.p)),
            snaps: await snapshot($, inst, blind),
          }
        }),
      )
      let result: Awaited<ReturnType<typeof next>>
      try {
        result = await next(e)
      } catch (err) {
        await Promise.all(hit.map((inst, i) => failTool($, inst, pending[i] ?? null)))
        throw err
      }
      hit.forEach((inst, i) => void afterTool($, inst, pending[i] ?? null, command, cwd, since, result as ToolResult, e.tool === 'PowerShell', epoch, prior[i]))
      return result
    } finally {
      inFlight -= 1
    }
  })

  // The answer is in and the session waits for the person: nothing stays lit.
  on('classic.Stop', async ($, e, next) => {
    waiting = true
    lightEpoch += 1
    for (const inst of instances.values()) {
      // A live step still playing finishes fast and what waits lights at once; then the usual clock.
      await finishLive($, inst)
      await unlight($, inst)
    }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.element !== 'rows' || !e.data || typeof e.data !== 'object') return next(e)
    const inst = await instanceFor($, e.requestId)
    if (!inst) return next(e)
    await onMessage($, inst, e)
    return {}
  })

  on('ui.focus', { component: 'Pane' }, async ($, e, next) => {
    const result = await next(e)
    const inst = await instanceFor($, e.requestId)
    if (inst) void sync($, inst)
    return result
  })

  on('ui.scroll', { component: 'Pane' }, async ($, e, next) => {
    const inst = await instanceFor($, e.requestId)
    if (!inst || !(await onScroll($, inst, e.by))) return next(e)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    const repo = instances.get(e.id)?.repo ?? (await repos($))[e.id]
    // A tab the person closed stays closed for the session: no card, no reopening.
    if (repo && e.origin.kind === 'person') await hush($, repo, true)
    if (e.origin.kind !== 'unload' && instances.has(e.id)) await closeRepo($, e.id)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    turn += 1
    void $.state.set(TURN, turn)
    for (const inst of instances.values()) {
      void settleBackground($, inst, e.text)
      void sync($, inst)
    }
    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    for (const inst of instances.values()) void settleBackground($, inst, e.text)
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    seen(e)
    if (e.requestId === CARD_ID) {
      if (!held || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
      return drawCard($.ui.resolve(e), held)
    }
    const inst = await instanceFor($, e.requestId)
    if (!inst) return next(e)
    return (await render($, inst, e)) ?? next(e)
  })

  // Where the card cannot get a pane of its own, it sits above the prompt on top of the other bands.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    seen(e)
    const below = await next(e)
    if (!held || held.where !== 'band' || (e.surface !== 'terminal' && e.surface !== 'desktop')) return below
    const ui = $.ui.resolve(e)
    const mine = drawCard(ui, held)
    if (!below) return mine
    const { Box } = ui
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
