import type { Step, StepFile } from '../types'
import { inside } from './tree'

export type { Step, StepFile }

export const TRAIL_MAX = 500
export const BRANCH_ROW = '#branch'

// Replay v2 sliders, in ticks of `tick` ms (cap in ms). brake: ticks per move on the 2 first and 2 last rows.
export const TIMING = { tick: 50, brake: 2, reveal: 1, rampUp: 5, iconTicks: 12, countTicks: 8, hold: 6, rampDown: 4, between: 4, bandTop: 3, bandBottom: 4, cap: 6000 } as const
export type Timing = { readonly [K in keyof typeof TIMING]: number }

// Live light: the short plan of one file (about 1 s), CATCH when the queue runs behind (the bar jumps, 400 ms a
// file) and RUSH when it runs far behind (250 ms a file).
// plan reads rampUp, iconTicks, countTicks, hold, rampDown, between and cap from these; tick, brake and reveal stay TIMING's.
export const LIVE: Timing = { ...TIMING, rampUp: 4, iconTicks: 8, countTicks: 6, hold: 0, rampDown: 3, between: 0, cap: 1500 }
export const CATCH: Timing = { ...TIMING, rampUp: 2, iconTicks: 4, countTicks: 4, hold: 0, rampDown: 1, between: 0, cap: 500 }
export const RUSH: Timing = { ...TIMING, rampUp: 1, iconTicks: 2, countTicks: 2, hold: 0, rampDown: 1, between: 0, cap: 250 }
// Files waiting in the live queue (one file a step): from `catch` on the next plan is CATCH, from `rush` on RUSH;
// past `overflow` the oldest waiting ones light at once, with no frames, and leave the queue.
export const LIVE_QUEUE = { catch: 2, rush: 8, overflow: 30 } as const

export type Frame =
  | { kind: 'bar'; row: string; ticks: number }
  | { kind: 'open'; dir: string }
  | { kind: 'reveal'; ids: string[] }
  | { kind: 'shade'; file: string; shade: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'icon'; file: string; frame: number; count: number }
  | { kind: 'wait'; ticks: number }
  | { kind: 'settle'; file: string }

// A light from an older command can land after a newer one started: it joins its own step, in order.
export function record(trail: Step[], step: Step, max = TRAIL_MAX): Step[] {
  const at = trail.findIndex(one => one.epoch === step.epoch)
  if (at >= 0) {
    const merged: Step = { ...trail[at]!, tones: { ...trail[at]!.tones, ...step.tones } }
    const files = mergeFiles(trail[at]!.files, step.files)
    if (files) merged.files = files
    // A later light finds the folders the first one opened: the step keeps every folder shut at its start.
    if (trail[at]!.shut || step.shut) merged.shut = [...new Set([...(trail[at]!.shut ?? []), ...(step.shut ?? [])])]
    // The result of a command finds the labels its start recorded: union, the first step's order, no repeats.
    if (trail[at]!.names || step.names) merged.names = [...new Set([...(trail[at]!.names ?? []), ...(step.names ?? [])])]
    // The git result comes with the scan, after the early light: a later one fills in.
    if (step.git) merged.git = step.git
    return [...trail.slice(0, at), merged, ...trail.slice(at + 1)]
  }
  const after = trail.findIndex(one => one.epoch > step.epoch)
  const next = after < 0 ? [...trail, step] : [...trail.slice(0, after), step, ...trail.slice(after)]
  return next.slice(-max)
}

// Per path, field by field: what comes later fills in, never erases.
function mergeFiles(a?: Record<string, StepFile>, b?: Record<string, StepFile>): Record<string, StepFile> | undefined {
  if (!a || !b) return b ?? a
  const out = { ...a }
  for (const [p, f] of Object.entries(b)) out[p] = { ...out[p], ...f }
  return out
}

export const NAME_MAX = 24
const SHELLS = new Set(['Bash', 'PowerShell'])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'exec', 'nohup'])

// The labels of one command, in order: a file tool is its own name (`Read`, `Edit`); a shell command gives the
// first word of each segment (`cd` `grep` `head`), `git <verb>` as one label (`git commit`), each cut at NAME_MAX
// with `…`. No count limit here: the drawing limits (see the phase 13 plan).
export function namesOf(tool: string, command: string): string[] {
  if (!SHELLS.has(tool)) return [tool]
  const out: string[] = []
  for (const seg of segments(withoutHeredocs(command))) {
    const label = labelOf(words(seg))
    if (label) out.push(label.length > NAME_MAX ? label.slice(0, NAME_MAX - 1) + '…' : label)
  }
  return out
}

// The lines of a here-document (`<<'PY'` up to the line `PY`) are the command's input, not commands: out they go.
function withoutHeredocs(command: string): string {
  const out: string[] = []
  let tag: string | null = null
  for (const line of command.split('\n')) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null
      continue
    }
    out.push(line)
    const m = /(?<!<)<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line)
    if (m) tag = m[1] ?? m[2] ?? m[3] ?? null
  }
  return out.join('\n')
}

// Splits on `&&`, `||`, `|`, `;` and newline outside quotes; `\` escapes the next char outside single quotes
// (so `grep "a\|b"`, `echo "x | y"` and `it's` do not split).
function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else if (c === quote) quote = null
    } else if (c === '\\') {
      cur += c
      if (i + 1 < command.length) cur += command[++i]
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '&' && command[i + 1] === '&') {
      out.push(cur)
      cur = ''
      i++
    } else if (c === '|') {
      out.push(cur)
      cur = ''
      if (command[i + 1] === '|') i++
    } else if (c === ';' || c === '\n') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

// Whitespace split outside quotes; the quotes stay on the word (so a word that starts with one is known).
function words(seg: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < seg.length) cur += seg[++i]
      else if (c === quote) quote = null
    } else if (c === '\\') {
      cur += c
      if (i + 1 < seg.length) cur += seg[++i]
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

// Git options before the verb that take the next token as their value (`git -C x status` → `git status`).
const COMMAND_WORD = /^[A-Za-z0-9_.+-]+$/
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])

// The label of one segment, or null when there is none: skips `VAR=x`, the wrappers (sudo, env...) and a lone
// bracket, takes the word without its path (`/usr/bin/grep` → `grep`), drops a word that starts with `$` or a
// quote. A subshell or group loses its brackets, so `(cd x && make) || true` gives `cd`, `make`, `true`.
function labelOf(tokens: string[]): string | null {
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!) || /^[(){}]+$/.test(tokens[i]!))) i++
  const raw = tokens[i]
  if (!raw) return null
  const bare = raw.replace(/^[({]+/, '').replace(/[)}]+$/, '')
  if (!bare || bare.startsWith('$') || bare.startsWith('"') || bare.startsWith("'")) return null
  const word = bare.slice(Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\')) + 1)
  // Only what looks like a program name: `open(p,'w')` or `s[k:]` out of a script's line is no command.
  if (!word || !COMMAND_WORD.test(word)) return null
  if (word !== 'git') return word
  let j = i + 1
  while (j < tokens.length && tokens[j]!.startsWith('-')) j += GIT_VALUED.has(tokens[j]!) ? 2 : 1
  const verb = tokens[j]?.replace(/[)}]+$/, '')
  return verb && COMMAND_WORD.test(verb) ? `git ${verb}` : 'git'
}

const lines = (text: string) => (text ? text.split('\n').length : 0)

// [added, removed] from the change in line count.
export function lineDelta(before: string, after: string): [number, number] {
  const d = lines(after) - lines(before)
  return d >= 0 ? [d, 0] : [0, -d]
}

export function stepsFor(trail: Step[], scope: 'last' | 'all', turn: number): Step[] {
  return scope === 'all' ? trail : trail.filter(one => one.turn === turn)
}

export type Kind = 'read' | 'edit' | 'shell' | 'born' | 'gone'

export function kindOf(step: Step, file: string): Kind {
  const f = step.files?.[file] ?? {}
  if (f.born) return 'born'
  if (f.gone) return 'gone'
  const tone = step.tones[file]
  if (tone === 'purple') return 'read'
  if (tone === 'orange' && (f.edit || f.added !== undefined || f.removed !== undefined)) return 'edit'
  return 'shell'
}

// The 5 tone ramp of a file: a shell edit (orange without counts) goes teal.
export function rampOf(step: Step, file: string): string {
  const kind = kindOf(step, file)
  if (kind === 'born') return 'green'
  if (kind === 'gone') return 'red'
  if (kind === 'read') return 'purple'
  if (kind === 'edit') return 'orange'
  const tone = step.tones[file] ?? 'teal'
  return tone === 'orange' ? 'teal' : tone
}

// A step's git chip turns final at the step's first settle and stays at least this long before the step ends:
// the between wait alone (4 ticks, 200 ms) went by unseen.
export const GIT_HOLD = 20

export function holdGit(frames: Frame[]): Frame[] {
  const at = frames.findIndex(f => f.kind === 'settle')
  if (at < 0) return frames
  const after = ticksOf(frames.slice(at + 1))
  return after >= GIT_HOLD ? frames : [...frames, { kind: 'wait', ticks: GIT_HOLD - after }]
}

export function ticksOf(frames: Frame[]): number {
  let n = 0
  for (const f of frames) {
    if (f.kind === 'bar' || f.kind === 'wait') n += f.ticks
    else if (f.kind === 'reveal') n += TIMING.reveal
    else if (f.kind === 'shade' || f.kind === 'icon') n += 1
  }
  return n
}

// One row per move, brake on the 2 first and 2 last; past 30 rows the middle moves `ceil(n/30)` rows per frame.
// boost raises the middle step (the cap), never below that.
function moves(rows: string[], from: number, to: number, boost = 0): Frame[] {
  const n = Math.abs(to - from)
  const dir = Math.sign(to - from)
  const k = Math.max(Math.ceil(n / 30), boost, 1)
  const out: Frame[] = []
  let s = 0
  while (s < n) {
    const edge = s < 2 || s >= n - 2
    s = edge ? s + 1 : Math.min(s + k, n - 2)
    out.push({ kind: 'bar', row: rows[from + s * dir]!, ticks: edge ? TIMING.brake : 1 })
  }
  return out
}

// Files the replayed step makes: out of the rows until the bar comes to each, then in at its place in order
// (the tree's rows with them in and the step's folders open).
export type Unborn = { order: string[]; ids: Set<string> }

// The route and the rows after it, or null when the target is not reachable.
// jump: folders on the path open at once (no bar, no reveal) and one bar frame lands on the target.
function walk(rows: string[], from: string | null, target: string, closed: string[], children: Record<string, string[]>, boost = 0, jump = false, unborn?: Unborn): { frames: Frame[]; rows: string[]; opened: string[] } | null {
  const shut = closed.filter(dir => dir !== target && inside(dir, target)).sort((a, b) => a.length - b.length)
  const work = [...rows]
  const frames: Frame[] = []
  const opened: string[] = []
  let at = from === null ? -1 : work.indexOf(from)
  const go = (row: string): boolean => {
    const to = work.indexOf(row)
    if (to < 0) return false
    if (at < 0) frames.push({ kind: 'bar', row, ticks: 1 })
    else frames.push(...moves(work, at, to, boost))
    at = to
    return true
  }
  for (const dir of shut) {
    if (jump) {
      if (!work.includes(dir)) return null
    } else if (!go(dir)) return null
    frames.push({ kind: 'open', dir })
    const kids = (children[dir] ?? []).filter(id => !work.includes(id))
    // boost 0 or 1 keeps one child a tick; over the cap, plan's boost packs more children in each tick.
    const per = Math.max(1, boost)
    if (!jump) for (let i = 0; i < kids.length; i += per) frames.push({ kind: 'reveal', ids: kids.slice(i, i + per) })
    work.splice(work.indexOf(dir) + 1, 0, ...kids)
    opened.push(dir)
  }
  if (unborn?.ids.has(target) && !work.includes(target)) {
    // In after the nearest row before it that is in: a shut folder's rows are out, so they never are.
    const at = unborn.order.indexOf(target)
    let i = at - 1
    while (i >= 0 && !work.includes(unborn.order[i]!)) i--
    if (at < 0 || i < 0) return null
    work.splice(work.indexOf(unborn.order[i]!) + 1, 0, target)
    frames.push({ kind: 'reveal', ids: [target] })
  }
  if (jump) {
    at = work.indexOf(target)
    if (at < 0) return null
    frames.push({ kind: 'bar', row: target, ticks: 1 })
  } else if (!go(target)) return null
  return { frames, rows: work, opened }
}

export function route(rows: string[], from: string | null, target: string, closed: string[], children: Record<string, string[]>, jump = false): Frame[] {
  return walk(rows, from, target, closed, children, 0, jump)?.frames ?? []
}

// Arrive, show, hold and let go of one row; the icon only on files.
function light(file: string, icon: boolean, timing: Timing): Frame[] {
  const out: Frame[] = []
  for (let s = 1; s <= timing.rampUp; s++) out.push({ kind: 'shade', file, shade: s as 1 })
  if (icon) for (let i = 1; i <= timing.iconTicks; i++) out.push({ kind: 'icon', file, frame: i, count: Math.min(1, i / timing.countTicks) })
  if (timing.hold > 0) out.push({ kind: 'wait', ticks: timing.hold })
  for (let s = timing.rampDown; s >= 1; s--) out.push({ kind: 'shade', file, shade: s as 1 })
  out.push({ kind: 'settle', file })
  return out
}

function build(step: Step, rows: string[], from: string | null, closed: Record<string, string[]>, boost: number, timing: Timing, jump: boolean, unborn?: Unborn): Frame[] {
  const files = Object.keys(step.tones).filter(p => p !== BRANCH_ROW)
  let work = [...rows]
  let bar = from
  let shut = Object.keys(closed)
  const out: Frame[] = []
  for (const file of files) {
    const way = walk(work, bar, file, shut, closed, boost, jump, unborn)
    if (!way) continue
    out.push(...way.frames, ...light(file, true, timing))
    work = way.rows
    shut = shut.filter(dir => !way.opened.includes(dir))
    bar = file
    if (kindOf(step, file) === 'gone') {
      const at = work.indexOf(file)
      work.splice(at, 1)
      bar = work.length ? work[Math.min(at, work.length - 1)]! : null
    }
  }
  if (!out.length && BRANCH_ROW in step.tones) out.push(...light(BRANCH_ROW, false, timing))
  if (out.length && timing.between > 0) out.push({ kind: 'wait', ticks: timing.between })
  return out
}

// The whole step. Over the cap, the routes walk more rows and reveal more children per frame; brakes, ramps, icon
// and hold stay.
// timing: TIMING (the replay), LIVE, CATCH or RUSH; jump moves the bar straight to each file (see route).
// unborn: the step's own new files, each comes in as the bar reaches it (see Unborn).
export function plan(step: Step, rows: string[], from: string | null, closed: Record<string, string[]>, timing: Timing = TIMING, jump = false, unborn?: Unborn): Frame[] {
  const limit = timing.cap / TIMING.tick
  const make = (boost: number) => build(step, rows, from, closed, boost, timing, jump, unborn)
  let frames = make(0)
  const most = rows.length + Object.values(closed).reduce((n, kids) => n + kids.length, 0)
  for (let boost = 2; ticksOf(frames) > limit && boost <= most; boost = Math.ceil(boost * 1.25)) frames = make(boost)
  if (ticksOf(frames) > limit) frames = make(most + 1)
  return frames
}

// A live step split one file a step, in the order its files came: BRANCH_ROW rides with the first, each file keeps
// its own files entry.
export function splitStep(step: Step): Step[] {
  const files = Object.keys(step.tones).filter(p => p !== BRANCH_ROW)
  if (files.length <= 1) return [step]
  return files.map((p, i) => {
    const tones: Record<string, string> = { [p]: step.tones[p]! }
    if (i === 0 && BRANCH_ROW in step.tones) tones[BRANCH_ROW] = step.tones[BRANCH_ROW]!
    const own = Object.fromEntries(Object.entries(step.files ?? {}).filter(([q]) => q in tones))
    const out: Step = { epoch: step.epoch, turn: step.turn, tones }
    if (Object.keys(own).length) out.files = own
    if (step.names) out.names = [...step.names]
    return out
  })
}
