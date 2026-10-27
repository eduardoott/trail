import { expect, mock, test } from 'claude-code/testing'
import { paneId } from '../hooks/wsl'
import { RAMPS, TONES } from '../hooks/git'
import { BRANCH_ROW, CATCH, route, RUSH, TIMING } from '../hooks/replay'

const WSL_ROOT = '//wsl.localhost/Ubuntu/home/user/my-repo'
const WIN_ROOT = 'C:/Users/user/Documents/Code/other'
const DIRS: Record<string, [string, 'file' | 'dir'][]> = {
  [WSL_ROOT]: [['database', 'dir'], ['wsl-only.md', 'file']],
  [WIN_ROOT]: [['src', 'dir'], ['win-only.md', 'file']],
  [`${WSL_ROOT}/database`]: [['schema.sql', 'file']],
}

const FILES: Record<string, string> = { [`${WSL_ROOT}/wsl-only.md`]: 'one\ntwo\n' }
const WSL_STATUS = '## main...origin/main\0 M wsl-only.md\0'

const waits: (() => void)[] = []
// front: a pane the person holds, which keeps the front whatever opens.
const git = { winStatus: '## dev\0?? win-only.md\0', wslStatus: WSL_STATUS, numstat: '', front: '', surface: 'desktop', cwd: 'C:/Users/user/Documents/Code/project' }

function world(on: any, ran: string[][], opens: any[], noGit = false) {
  waits.length = 0
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\user' })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: git.cwd }))
  on('session.surfaces', () => ({ value: [git.surface] }))
  on('command.register', () => ({ value: undefined }))
  // The last pane opened is the one shown, the others are tabs behind it.
  on('ui.panes', () => {
    const shown = git.front || opens.at(-1)?.id
    const ids = [...new Set([...(git.front ? [git.front] : []), ...opens.map(o => o.id)])]
    return { value: ids.map(id => ({ id, title: id, isShown: id === shown, isFocused: false, isPlaced: true })) }
  })
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('fs.read', (_$: any, e: any) => {
    const text = FILES[norm(e.path)]
    if (text === undefined) throw new Error('no file')
    return { value: text }
  })
  on('fs.list', (_$: any, e: any) => {
    const kids = DIRS[norm(e.path)]
    if (!kids) throw new Error(`ENOENT ${e.path}`)
    return { value: kids.map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1_700_000_000_000, isLink: false })) }
  })
  on('fs.stat', (_$: any, e: any) => {
    const path = norm(e.path)
    if (DIRS[path]) return { value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }
    const cut = path.lastIndexOf('/')
    if (DIRS[path.slice(0, cut)]?.some(([name, kind]) => name === path.slice(cut + 1) && kind === 'file')) return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // The card's wait: one step each time the test calls tick().
    if (argv[0] === 'node') return new Promise(done => waits.push(() => done(ok(''))))
    if (noGit) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'wsl.exe' && argv.includes('sh')) return ok('/home/user/my-repo\nUbuntu\n')
    const verb = argv.find((a, i) => i > argv.indexOf('-C') + 1 && !a.startsWith('-'))
    if (verb === 'rev-parse' && argv.includes('--show-prefix')) return ok(argv[0] === 'wsl.exe' ? '\n/home/user/my-repo\n' : `\n${WIN_ROOT}\n`)
    if (verb === 'rev-parse') return ok(`${WIN_ROOT}\n`)
    if (verb === 'status') return ok(argv[0] === 'wsl.exe' ? git.wslStatus : git.winStatus)
    if (verb === 'diff' && argv.includes('--numstat') && argv[0] === 'wsl.exe') return ok(git.numstat)
    return ok('')
  })
  return clock
}

const props = { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any
const openCmd = (args: string) => ({ command: 'trail', args: args ? `open ${args}` : '', origin: { kind: 'person' }, presentation: { isFullscreen: true, columns: 200 } }) as any

test('two repos open two panes of one mod, each drawing its own root and git', { options: { sessionTab: 'off' }, timeoutMs: 20_000 }, async ($, on) => {
  const ran: string[][] = []
  const opens: any[] = []
  const clock = world(on, ran, opens)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const a = await $.command.run(openCmd('\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo'))
  const b = await $.command.run(openCmd(WIN_ROOT))
  await clock.settle()
  expect(JSON.stringify(a)).toContain('WSL my-repo')
  expect(JSON.stringify(b)).toContain('other')
  const wslId = paneId('wsl:/home/user/my-repo')
  const winId = paneId(`win:${WIN_ROOT}`)
  expect(opens.map(o => o.id)).toEqual([wslId, winId])
  expect(opens[0].title).toBe('WSL my-repo')

  // The WSL repo's git runs in the distro, never the Windows git over the UNC path.
  expect(ran.some(r => r[0] === 'git' && r.some(x => x.includes('wsl.localhost')))).toBe(false)
  expect(ran.some(r => r[0] === 'wsl.exe' && r.includes('status') && r.includes('/home/user/my-repo'))).toBe(true)

  for (const [id, mine, other, branch] of [[wslId, 'wsl-only.md', 'win-only.md', 'main'], [winId, 'win-only.md', 'wsl-only.md', 'dev']] as const) {
    const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: id, props })
    await clock.settle()
    const shown = JSON.stringify(await ui.drawn()) + JSON.stringify(await ui.drawn({ in: 'rows' }))
    expect(shown).toContain(mine)
    expect(shown).toContain(branch)
    expect(shown.includes(other)).toBe(false)
  }

  const list = await $.command.run(openCmd(''))
  expect(JSON.stringify(list)).toContain('wsl:/home/user/my-repo')
  expect(JSON.stringify(list)).toContain(`win:${WIN_ROOT}`)
})

test('a folder outside any git repo opens nothing', { options: { sessionTab: 'off' } }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens, true)
  await $.session.start({ cwd: 'C:/x', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const r = await $.command.run(openCmd('C:\\Users\\user\\Downloads'))
  expect(JSON.stringify(r)).toContain('is not in a git repo')
  expect(opens.length).toBe(0)
})

for (const followTab of ['on', 'off'] as const) {
  test(`a read in the tab behind brings it to the front only with followTab ${followTab}`, { options: { followTab, sessionTab: 'off' }, timeoutMs: 20_000 }, async ($, on) => {
    const opens: any[] = []
    const clock = world(on, [], opens)
    on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
    await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run(openCmd('\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo'))
    await $.command.run(openCmd(WIN_ROOT))
    await clock.settle()
    const before = opens.length
    await $.tool.call({ tool: 'Read', file_path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo\\wsl-only.md' } as any)
    await clock.settle()
    const raised = opens.slice(before).map(o => o.id)
    expect(raised).toEqual(followTab === 'on' ? [paneId('wsl:/home/user/my-repo')] : [])
    expect(opens.slice(before).some(o => o.focus)).toBe(false)
  })
}

test('the session repo gets its own tab at start, once, and only with sessionTab on', { timeoutMs: 20_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens)
  await $.session.start({ cwd: WIN_ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(opens.map(o => o.id)).toEqual([paneId(`win:${WIN_ROOT}`)])
  expect(opens[0].focus).toBe(undefined)
  await $.session.start({ cwd: WIN_ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(opens.length).toBe(1)
})

for (const count of [150, 1500]) test(`a folder with ${count} files on the desktop still draws, inside the 100,000 character bound`, { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const small = DIRS[WIN_ROOT]!
  DIRS[WIN_ROOT] = Array.from({ length: count }, (_, i) => [`file-com-um-nome-bem-comprido-de-procedure-${String(i).padStart(4, '0')}.sql`, 'file'] as [string, 'file'])
  try {
    const opens: any[] = []
    const clock = world(on, [], opens)
    await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run(openCmd(WIN_ROOT))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: paneId(`win:${WIN_ROOT}`), props })
    await clock.settle()
    const tree = JSON.stringify(await ui.drawn())
    const rows = JSON.stringify(await ui.drawn({ in: 'rows' }))
    expect(rows).toContain('file-com-um-nome')
    expect(tree.length).toBeLessThan(100_000)
    expect(rows.length).toBeLessThan(100_000)
  } finally {
    DIRS[WIN_ROOT] = small
  }
})

test('the ± button keeps only what git counts as changed, opening the folders they sit in', { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const src = `${WIN_ROOT}/src`
  DIRS[src] = [['mudou.sql', 'file'], ...Array.from({ length: 30 }, (_, i) => [`intacto-${i}.sql`, 'file'] as [string, 'file'])]
  git.winStatus = '## dev\0?? win-only.md\0 M src/mudou.sql\0'
  try {
    const opens: any[] = []
    const clock = world(on, [], opens)
    await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run(openCmd(WIN_ROOT))
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: paneId(`win:${WIN_ROOT}`), props })
    await clock.settle()
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('mudou.sql')
    await ui.press({ key: 'changed' })
    await clock.settle()
    const rows = JSON.stringify(await ui.drawn({ in: 'rows' }))
    expect(rows).toContain('mudou.sql')
    expect(rows).toContain('win-only.md')
    expect(rows).not.toContain('intacto-')
    expect(JSON.stringify(await ui.drawn())).toContain('changed only')
    await ui.press({ key: 'changed' })
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).not.toContain('changed only')
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('intacto-')
  } finally {
    delete DIRS[src]
    git.winStatus = '## dev\0?? win-only.md\0'
  }
})

async function litWorld($: any, on: any, pane = props) {
  const opens: any[] = []
  const clock = world(on, [], opens)
  // fail: the calls answer as core does when the tool errs, isError beside the result.
  // result: what the next call answers with instead of the plain ok (a Bash result with its gitOperation).
  // release answers every call still held, so calls sent together go together.
  const gate = { release: () => {}, fail: false, result: null as any }
  const held: (() => void)[] = []
  on('tool.call', () => new Promise(done => {
    held.push(() => done(gate.fail ? { result: 'error', text: 'error', isError: true } : gate.result ?? { result: { text: 'ok', isError: false } }))
    gate.release = () => { for (const go of held.splice(0)) go() }
  }) as any)
  on('classic.Stop', () => ({}) as any)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run(openCmd('\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo'))
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: paneId('wsl:/home/user/my-repo'), props: pane })
  await clock.settle()
  // A lit name shimmers one character per Text, so the whole name no longer appears in one piece.
  const lit = async (name: string) => !JSON.stringify(await ui.drawn({ in: 'rows' })).includes(name)
  const read = (name = 'wsl-only.md') => $.tool.call({ tool: 'Read', file_path: `\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo\\${name}` } as any)
  return { clock, gate, lit, read, ui }
}

// One command, start to end, then the answer ends: what the person sees before pressing replay.
async function command(clock: any, gate: any, call: Promise<unknown>) {
  await clock.advance(50)
  gate.release()
  await call
}

test('replay lights one command at a time for two seconds, and ▷ plays only the last interaction', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, lit, read, ui } = await litWorld($, on)
  const drawn = async () => JSON.stringify(await ui.drawn())
  expect(await drawn()).not.toContain('▷')

  await $.prompt.submit({ text: 'primeiro' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await command(clock, gate, read('database'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  expect(await lit('wsl-only.md')).toBe(false)
  expect(await lit('database')).toBe(false)

  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  expect(await drawn()).toContain('■ 1/2')
  expect(await lit('wsl-only.md')).toBe(true)
  expect(await lit('database')).toBe(false)
  await clock.advance(2_000)
  expect(await drawn()).toContain('■ 2/2')
  expect(await lit('wsl-only.md')).toBe(false)
  expect(await lit('database')).toBe(true)
  await clock.advance(2_000)
  expect(await lit('database')).toBe(false)
  expect(await drawn()).not.toContain('replay-stop')

  await $.prompt.submit({ text: 'segundo' } as any)
  await command(clock, gate, read('database'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  expect(await drawn()).toContain('■ 1/1')
  expect(await lit('database')).toBe(true)
  await clock.advance(2_000)

  await ui.press({ key: 'replay-all' })
  await clock.advance(10)
  expect(await drawn()).toContain('■ 1/3')
  expect(await lit('wsl-only.md')).toBe(true)
})

test('■ stops the replay, and a new command stops it too', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, lit, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await command(clock, gate, read('database'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)

  await ui.press({ key: 'replay-all' })
  await clock.advance(10)
  expect(await lit('wsl-only.md')).toBe(true)
  await ui.press({ key: 'replay-stop' })
  await clock.advance(10)
  expect(await lit('wsl-only.md')).toBe(false)
  await clock.advance(5_000)
  expect(await lit('database')).toBe(false)

  await ui.press({ key: 'replay-all' })
  await clock.advance(10)
  expect(await lit('wsl-only.md')).toBe(true)
  const next = $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).not.toContain('replay-stop')
  gate.release()
  await next
  await clock.advance(5_000)
  expect(await lit('database')).toBe(false)
})

// modern plays frames of TIMING.tick: the tests walk the fake clock one tick at a time.
const TICK = TIMING.tick
// One step of a single file: jump onto it, 5 tones up, 12 icon frames, hold 6, 4 tones down, 4 between.
const LIT = 1 + 5 + 12 + 6 + 4 + 4
const specs = async (ui: any): Promise<any[]> => clientRows(await ui.drawn()) ?? []
// The bar's ▌ sits in the gutter column every row gets while modern plays.
const barOf = (rows: any[]) => rows.find(r => r.left.some((s: any) => s.t.startsWith('▌')))?.id ?? null
// A fold row's id ends with the id of its first hidden file: rowOf never answers with one.
const rowOf = (rows: any[], name: string) => rows.find(r => (r.id.endsWith(`/${name}`) && !r.id.includes(' ')) || (r.id === '' && r.left.some((s: any) => s.t === name)))
const nameAt = (row: any, name: string) => row?.left.findIndex((s: any) => s.t.startsWith(name)) ?? -1
const nameSeg = (row: any, name: string) => row?.left[nameAt(row, name)]
const glyphSeg = (row: any, name: string) => row?.left[nameAt(row, name) - 1]
const MANY: [string, 'file'][] = Array.from({ length: 20 }, (_, i) => [`a${String(i).padStart(2, '0')}.md`, 'file'])

// 7.1: the bar persists from step to step and walks to the next file as route plans it.
test('the bar walks to the next file one row per tick, braking two ticks at each end, as route plans it', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('a01.md'))
    await command(clock, gate, read('a09.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    const ids: string[] = (await specs(ui)).map(r => r.id)
    const id = (name: string) => ids.find(x => x.endsWith(`/${name}`))!
    await ui.press({ key: 'replay-last' })
    expect(barOf(await specs(ui))).toBe(id('a01.md'))
    await clock.advance((LIT - 1) * TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/2')
    await clock.advance(TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 2/2')
    const walk = route(ids, id('a01.md'), id('a09.md'), [], {})
    expect(walk.map(f => (f.kind === 'bar' ? f.ticks : 0))).toEqual([2, 2, 1, 1, 1, 1, 2, 2])
    for (const f of walk) {
      if (f.kind !== 'bar') continue
      for (let k = 0; k < f.ticks; k++) {
        expect(barOf(await specs(ui))).toBe(f.row)
        await clock.advance(TICK)
      }
    }
    expect(barOf(await specs(ui))).toBe(id('a09.md'))
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// The first step walks from the person's cursor, which stays where it is.
test('the first step sets the bar out from the cursor, and the cursor does not move', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('a05.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.key({ key: 'home' })
    const ids: string[] = (await specs(ui)).map(r => r.id)
    const id = (name: string) => ids.find(x => x.endsWith(`/${name}`))!
    await ui.press({ key: 'replay-last' })
    const walk = route(ids, ids[0]!, id('a05.md'), [], {})
    expect(walk.length).toBe(6)
    for (const f of walk) {
      if (f.kind !== 'bar') continue
      expect(barOf(await specs(ui))).toBe(f.row)
      await clock.advance(f.ticks * TICK)
    }
    expect(barOf(await specs(ui))).toBe(id('a05.md'))
    expect(clientOf(await ui.drawn()).props.props.active).toBe(ids[0])
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// 7.2: the bar stops on the closed folder, it opens, and its children come in one per tick.
test('a closed folder on the way opens under the bar, its children coming in one per tick', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[`${WSL_ROOT}/database`]!
  DIRS[`${WSL_ROOT}/database`] = [['a.sql', 'file'], ...db]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    const shows = async (name: string) => Boolean(rowOf(await specs(ui), name))
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('database\\schema.sql'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'collapse' })
    await ui.press({ key: 'replay-last' })
    expect(barOf(await specs(ui))).toMatch(/\/database$/)
    expect(await shows('a.sql')).toBe(false)
    await clock.advance(TICK)
    expect(await shows('a.sql')).toBe(true)
    expect(await shows('schema.sql')).toBe(false)
    await clock.advance(TICK)
    expect(await shows('schema.sql')).toBe(true)
    // The bar moves on toward the file: the folder's ▾ shows again.
    expect(barOf(await specs(ui))).toMatch(/\/database$/)
    await clock.advance(TICK)
    expect(barOf(await specs(ui))).toMatch(/\/a\.sql$/)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).toContain('▾')
    // The step: the light, two children and two rows with the brake; 3 ticks are gone.
    await clock.advance((LIT + 2 + 4 - 3 - 1) * TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    await clock.advance(TICK)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
    expect(await shows('schema.sql')).toBe(true)
  } finally {
    DIRS[`${WSL_ROOT}/database`] = db
  }
})

// B1: the live light opens the folder, and nobody shuts it before ▷. The step remembers it was shut,
// so the replay shuts it again and the bar opens it.
test('replay opens the folder the live light opened, without a collapse in between', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const drawn = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('database\\schema.sql'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  expect(await drawn()).toContain('schema.sql')
  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  expect(await drawn()).not.toContain('schema.sql')
  await clock.advance(TICK)
  expect(await drawn()).toContain('schema.sql')
  await clock.advance(5_000)
  expect(await drawn()).toContain('schema.sql')
  expect(await drawn()).toContain('▾')
})

// 7.3: tone k of the purple ramp on tick k of the arrival; back down after the hold, then the settled tone.
test('the file climbs 5 tones on arrival, drops 4 after the hold and keeps the settled tone to the end', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  const tone = async () => nameSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')?.c
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  expect(ramp.includes(await tone())).toBe(false)
  for (let k = 1; k <= 5; k++) {
    if (k === 3) expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain(ramp[2]!)
    await clock.advance(TICK)
    expect(await tone()).toBe(ramp[k - 1])
    if (k === 3) expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).toContain(`"color":"${ramp[2]}"`)
  }
  await clock.advance(18 * TICK)
  expect(await tone()).toBe(ramp[4])
  for (const k of [4, 3, 2, 1]) {
    await clock.advance(TICK)
    expect(await tone()).toBe(ramp[k - 1])
  }
  await clock.advance(TICK)
  expect(await tone()).toBe(ramp[1])
  await clock.advance(3 * TICK)
  expect(await tone()).toBe(ramp[1])
  await clock.advance(TICK)
  expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  expect(ramp.includes(await tone())).toBe(false)
})

// 7.4: the icon takes the glyph's place for 12 ticks, its tone cycling 5 4 3 4 (frame % 4).
// 8.4: then it stays still in tone 3 through the hold (6) and the 4 tones down, and leaves on the settle.
// The desktop draws plain glyphs; glyphs nerd draws the Nerd Font ones.
for (const [glyphs, icon] of [['auto', '⌕'], ['nerd', '\u{f002}']] as const) {
  test(`a Read plays its ${glyphs} icon for 12 ticks with its tone cycling, then keeps it still in tone 3 until the settle`, { options: { sessionTab: 'off', replayAnimation: 'modern', glyphs }, timeoutMs: 30_000 }, async ($, on) => {
    const { clock, gate, read, ui } = await litWorld($, on)
    const ramp = RAMPS.purple!
    const glyph = async () => glyphSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('wsl-only.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'replay-last' })
    await clock.advance(5 * TICK)
    const own = (await glyph()).t
    expect(own).not.toBe(`${icon} `)
    for (let f = 1; f <= 12; f++) {
      await clock.advance(TICK)
      expect(await glyph()).toEqual({ t: `${icon} `, c: ramp[[5, 4, 3, 4][f % 4]! - 1] })
    }
    for (let k = 1; k <= 10; k++) {
      await clock.advance(TICK)
      expect(await glyph()).toEqual({ t: `${icon} `, c: ramp[2] })
    }
    await clock.advance(TICK)
    expect((await glyph()).t).toBe(own)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain(icon)
  })
}

const atWsl = (name: string) => `\\\\wsl.localhost\\Ubuntu\\home\\user\\my-repo\\${name}`

// 7.5: round(5 × frame / 8) reaches 5 only on frame 8 of the ✎ icon; the dots grow one every 3 ticks.
test('an Edit counts its lines up over 8 ticks of the ✎ icon, with dots after the name', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'two\na\nb\nc\nd\ne' } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  await clock.advance(5 * TICK)
  for (let f = 1; f <= 12; f++) {
    await clock.advance(TICK)
    const row = rowOf(await specs(ui), 'wsl-only.md')
    expect(glyphSeg(row, 'wsl-only.md').t).toBe('✎ ')
    expect(nameSeg(row, 'wsl-only.md').t).toBe(`wsl-only.md ${'·'.repeat(Math.min(3, Math.ceil(f / 3)))}`)
    const right = row.right.map((s: any) => s.t)
    if (f === 7) expect(right).toContain(' +4')
    if (f < 8) expect(right).not.toContain(' +5')
    else expect(right).toContain(' +5')
  }
  expect(JSON.stringify(await ui.drawn())).toContain('" +5"')
  await clock.advance(TICK)
  // 8.4: the dots go with the frames; the ✎ stays as a still mark.
  expect(nameSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md').t).toBe('wsl-only.md')
  expect(glyphSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')).toEqual({ t: '✎ ', c: RAMPS.orange![2] })
  await clock.advance((LIT - 18) * TICK)
  expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('" +5"')
})

// Edit: two lines more, counted during the icon. Write of a new file: hidden until its own step (D6),
// then drawn with git's ? badge.
test('an Edit records added and removed lines, and a Write of a new file records born', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
    const drawn = async () => JSON.stringify(await ui.drawn())
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'two\ntres\nquatro' } as any))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    expect(await rows()).not.toContain('" +2"')
    await ui.press({ key: 'replay-last' })
    await clock.advance(13 * TICK + 10)
    expect(await rows()).toContain('" +2"')
    expect(await rows()).not.toContain('" -')
    await clock.advance(LIT * TICK)
    expect(await rows()).not.toContain('" +2"')

    await $.prompt.submit({ text: 'y' } as any)
    const call = $.tool.call({ tool: 'Write', file_path: atWsl('new.md'), content: 'a\nb' } as any)
    await clock.advance(50)
    DIRS[WSL_ROOT] = [...root, ['new.md', 'file']]
    git.wslStatus = `${WSL_STATUS}?? new.md\0`
    gate.release()
    await call
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    expect(await rows()).toContain('new.md')
    await ui.press({ key: 'replay-all' })
    await clock.advance(10)
    expect(await drawn()).toContain('■ 1/2')
    expect(await rows()).not.toContain('new.md')
    await clock.advance(LIT * TICK)
    expect(await drawn()).toContain('■ 2/2')
    expect(await rows()).toContain('new.md')
    expect(await rows()).toContain('" ?"')
  } finally {
    DIRS[WSL_ROOT] = root
    git.wslStatus = WSL_STATUS
  }
})

// D7: the row counts from 0 to 2 over the icon, the top adds the count to git's total, both go back after.
test('counters count up from zero during the icon and go back to the git numbers after', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  try {
    git.numstat = '5\t1\twsl-only.md\0'
    const { clock, gate, ui } = await litWorld($, on)
    const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
    const drawn = async () => JSON.stringify(await ui.drawn())
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'two\ntres\nquatro' } as any))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    expect(await rows()).toContain('" +5"')
    expect(await rows()).toContain('" -1"')
    await ui.press({ key: 'replay-last' })
    await clock.advance(6 * TICK + 10)
    expect(await rows()).not.toContain('" +5"')
    expect(await rows()).not.toContain('" +2"')
    await clock.advance(5 * TICK)
    expect(await rows()).toContain('" +2"')
    expect(await drawn()).toContain('" +7"')
    await clock.advance(LIT * TICK)
    expect(await drawn()).not.toContain('■ 1/1')
    expect(await rows()).toContain('" +5"')
    expect(await rows()).toContain('" -1"')
    expect(await drawn()).not.toContain('" +7"')
  } finally {
    git.numstat = ''
  }
})

// The file is gone from the tree after the rm; its step draws it struck through in its old place,
// and it leaves the list on the settle.
test('a shell rm records gone, and the replay shows a struck ghost that leaves on the settle', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
    await $.prompt.submit({ text: 'x' } as any)
    const call = $.tool.call({ tool: 'Bash', command: `rm '${atWsl('wsl-only.md')}'` } as any)
    await clock.advance(50)
    DIRS[WSL_ROOT] = root.filter(([name]) => name !== 'wsl-only.md')
    gate.release()
    await call
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    expect(await rows()).not.toContain('wsl-only.md')
    await ui.press({ key: 'replay-last' })
    await clock.advance(10)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    expect(await rows()).toContain('{"type":"Text","props":{"color":"#d0605e","strikethrough":true},"children":["wsl-only.md"]}')
    await clock.advance(3 * TICK)
    expect(await rows()).toContain(`{"type":"Text","props":{"color":"${RAMPS.red![2]}","strikethrough":true},"children":["wsl-only.md"]}`)
    await clock.advance(6 * TICK)
    expect(glyphSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md').t).toBe('× ')
    // On the settle, tick 28 of the step.
    await clock.advance((27 - 9) * TICK)
    expect(await rows()).toContain('wsl-only.md')
    await clock.advance(TICK)
    expect(await rows()).not.toContain('wsl-only.md')
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    await clock.advance(4 * TICK)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
    expect(await rows()).not.toContain('wsl-only.md')
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// 7.6: the window moves only when the bar leaves the band, 3 rows from the top and 4 from the bottom.
test('the window follows the bar only when it leaves the band', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, read, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 12 } })
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('a01.md'))
    await command(clock, gate, read('a15.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    const ids: string[] = (await specs(ui)).map(r => r.id)
    const id = (name: string) => ids.find(x => x.endsWith(`/${name}`))!
    await ui.press({ key: 'replay-last' })
    const room = (await specs(ui)).length
    expect(room).toBeLessThan(ids.length)
    expect((await specs(ui))[0].id).toBe(ids[0])
    await clock.advance(LIT * TICK)
    let top = 0
    let moved = 0
    for (const f of route(ids, id('a01.md'), id('a15.md'), [], {})) {
      if (f.kind !== 'bar') continue
      const at = ids.indexOf(f.row)
      const inBand = at >= top + TIMING.bandTop && at <= top + room - TIMING.bandBottom
      if (!inBand) {
        top = at - room + TIMING.bandBottom
        moved++
      }
      const shown = await specs(ui)
      expect(barOf(shown)).toBe(f.row)
      expect(shown[0].id).toBe(ids[top])
      await clock.advance(f.ticks * TICK)
    }
    expect(moved).toBeGreaterThan(0)
    expect(top).toBeGreaterThan(0)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// 7.7: ■ puts out the bar, the icon, the tones and the rows still hidden at once, and no timer outlives it.
test('■ in the middle of a step clears the bar, the icon, the tones and the hidden rows in one go', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[`${WSL_ROOT}/database`]!
  DIRS[`${WSL_ROOT}/database`] = [['a.sql', 'file'], ...db]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    const ramp = RAMPS.purple!
    const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('database\\schema.sql'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'collapse' })
    await ui.press({ key: 'replay-last' })
    await clock.advance(TICK)
    expect(rowOf(await specs(ui), 'schema.sql')).toBe(undefined)
    await ui.press({ key: 'replay-stop' })
    expect(barOf(await specs(ui))).toBe(null)
    expect(rowOf(await specs(ui), 'schema.sql')).not.toBe(undefined)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')

    await ui.press({ key: 'replay-last' })
    await clock.advance(20 * TICK)
    const lit = await rows()
    expect(lit).toContain('⌕')
    expect(lit).toContain('▌')
    expect(ramp.some(c => lit.includes(c))).toBe(true)
    await ui.press({ key: 'replay-stop' })
    const after = await rows()
    expect(barOf(await specs(ui))).toBe(null)
    expect(after).not.toContain('⌕')
    expect(after).not.toContain('▌')
    for (const c of ramp) expect(after).not.toContain(c)
    const before = JSON.stringify(await ui.drawn()) + after
    await clock.advance(5_000)
    expect(JSON.stringify(await ui.drawn()) + (await rows())).toBe(before)
  } finally {
    DIRS[`${WSL_ROOT}/database`] = db
  }
})

// Had a timer outlived the stop, the folder would open (▾) later on its own.
// The desktop scrollbar cannot show here: three rows never overflow the 40-row window.
test('■ before the bar reaches the folder leaves it shut, and a new command stops modern too', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('database\\schema.sql'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'collapse' })
  await ui.press({ key: 'replay-last' })
  await clock.advance(20)
  expect(barOf(await specs(ui))).toMatch(/\/database$/)
  await ui.press({ key: 'replay-stop' })
  await clock.advance(10)
  expect(await rows()).not.toContain('schema.sql')
  expect(await rows()).not.toContain('▾')
  expect(barOf(await specs(ui))).toBe(null)
  expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  await clock.advance(5_000)
  expect(await rows()).not.toContain('▾')
  expect(barOf(await specs(ui))).toBe(null)

  await ui.press({ key: 'replay-last' })
  await clock.advance(20)
  expect(barOf(await specs(ui))).toMatch(/\/database$/)
  const next = $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  expect(barOf(await specs(ui))).toBe(null)
  gate.release()
  await next
  await clock.advance(5_000)
  expect(await rows()).not.toContain('▾')
  expect(barOf(await specs(ui))).toBe(null)
})

test('a step whose file is gone is skipped without stalling the player', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('wsl-only.md'))
    await command(clock, gate, read('database'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    DIRS[WSL_ROOT] = root.filter(([name]) => name !== 'wsl-only.md')
    await ui.press({ key: 'refresh' })
    await clock.advance(10)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('wsl-only.md')
    await ui.press({ key: 'replay-all' })
    await clock.advance(10)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 2/2')
    expect(barOf(await specs(ui))).toMatch(/\/database$/)
    await clock.advance(LIT * TICK)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 2/2')
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// 7.8: the speed button scales the whole tick: at 0.5x each frame takes twice the ms.
test('at 0.5x the same step takes twice the time, tick by tick', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  const tone = async () => nameSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')?.c
  await ui.press({ key: 'speed' })
  await ui.press({ key: 'speed' })
  await ui.press({ key: 'speed' })
  try {
    expect(JSON.stringify(await ui.drawn())).toContain('0.5x')
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('wsl-only.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'replay-last' })
    await clock.advance(5 * TICK)
    expect(await tone()).toBe(ramp[1])
    await clock.advance(TICK)
    expect(await tone()).toBe(ramp[2])
    await clock.advance((2 * LIT - 6 - 1) * TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    await clock.advance(TICK)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  } finally {
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
  }
})

// At 2x each frame takes half the ms: the step that lasts LIT ticks at 1x ends at LIT / 2.
test('at 2x the same step takes half the time', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await ui.press({ key: 'speed' })
  try {
    expect(JSON.stringify(await ui.drawn())).toContain('2x')
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('wsl-only.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'replay-last' })
    await clock.advance((LIT / 2 - 1) * TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    await clock.advance(TICK)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  } finally {
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
  }
})

// At 5x each frame takes a fifth of the ms: a tick of TICK / 5, sampled tick by tick.
test('at 5x the same step takes a fifth of the time, tick by tick', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  const fast = TICK / 5
  const tone = async () => nameSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')?.c
  await ui.press({ key: 'speed' })
  await ui.press({ key: 'speed' })
  try {
    expect(JSON.stringify(await ui.drawn())).toContain('"label":"5x"')
    await $.prompt.submit({ text: 'x' } as any)
    await command(clock, gate, read('wsl-only.md'))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'replay-last' })
    await clock.advance(2 * fast)
    expect(await tone()).toBe(ramp[1])
    await clock.advance(fast)
    expect(await tone()).toBe(ramp[2])
    await clock.advance((LIT - 3 - 1) * fast)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
    await clock.advance(fast)
    expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
  } finally {
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
    await ui.press({ key: 'speed' })
  }
})

// A reload starts the module over: the trail and the turn wait in $.state for the replay after it.
test('the trail and the turn are kept in state, for the replay after a reload', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const saved: Record<string, any> = {}
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'trail' && (e.key === 'trail' || e.key === 'turn')) saved[e.key] = e.value
    return next(e)
  })
  const { clock, gate, read } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(saved.trail.length).toBe(1)
  expect(Object.keys(saved.trail[0].tones)).toEqual([`${WSL_ROOT}/wsl-only.md`])
  expect(saved.trail[0].turn).toBe(saved.turn)
})

// The trail as the last state.set left it; registered before litWorld, as the test above does.
function trailSaved(on: any): { trail: any[] } {
  const saved = { trail: [] as any[] }
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'trail' && e.key === 'trail') saved.trail = e.value
    return next(e)
  })
  return saved
}

// 13.3: every step keeps the labels of the command that made it; the early light and the result of the same call
// record once (`Read`, not `Read` twice).
test('a Read, an Edit and a sed record their names on the step', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const saved = trailSaved(on)
  const { clock, gate, read } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await clock.settle()
  expect(saved.trail.length).toBe(1)
  expect(saved.trail[0].names).toEqual(['Read'])

  await command(clock, gate, $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'three' } as any))
  await clock.settle()
  expect(saved.trail.length).toBe(2)
  expect(saved.trail[1].names).toEqual(['Edit'])

  await command(clock, gate, $.tool.call({ tool: 'Bash', command: `sed -i 's/a/b/' '${atWsl('wsl-only.md')}'` } as any))
  await clock.settle()
  expect(saved.trail.length).toBe(3)
  expect(Object.keys(saved.trail[2].tones)).toEqual([`${WSL_ROOT}/wsl-only.md`])
  expect(saved.trail[2].names).toEqual(['sed'])
  await $.classic.Stop({ stop_hook_active: false } as any)
})

test('a git add and commit record `git add` and `git commit` on the branch step', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const saved = trailSaved(on)
  const { clock, gate } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  // The commit is proven by the sha core reports in the result.
  gate.result = { result: { text: 'ok', isError: false, gitOperation: { commit: { sha: 'abc1234def' } } } }
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: 'git -C /home/user/my-repo add -A && git -C /home/user/my-repo commit -m x' } as any))
  await clock.settle()
  const step = saved.trail.find((one: any) => BRANCH_ROW in one.tones)
  expect(step?.tones[BRANCH_ROW]).toBe('green')
  expect(step?.names).toEqual(['git add', 'git commit'])
  await $.classic.Stop({ stop_hook_active: false } as any)
})

// 13.4: the segments after the name of a row (the chips of its command, with the ' ' before each).
const afterName = (row: any, name: string): any[] => (row ? row.left.slice(nameAt(row, name) + 1) : [])
// One chip as rowSpec draws it: a space, then the label padded on the tone, square.
const chip = (label: string, bg: string) => [{ t: ' ' }, { t: ` ${label} `, c: '#1b1b1f', bg }]
const DARK_TEXT = '#1b1b1f'
// The chips of the branch row, drawn as Text with a backgroundColor: the label and its background.
const branchChips = (drawn: any): [string, string][] => [...JSON.stringify(drawn).matchAll(/"backgroundColor":"(#[0-9a-fA-F]{6})"[^{}]*\},"children":\["([^"]+)"\]/g)].map(m => [m[2]!, m[1]!])

test('▷ of a Read draws a Read chip after the name in the tone of the frame, gone once settled, none before the step reaches it', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  const chips = async () => afterName(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain(' Read ')
  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  // The bar jumps onto the row first: no chip until its first tone.
  expect(await chips()).toEqual([])
  for (let k = 1; k <= 5; k++) {
    await clock.advance(TICK)
    const bg = ramp[k - 1]!
    expect(await chips()).toEqual([{ t: ' ' }, { t: ' Read ', bg, ...(k >= 3 ? { c: DARK_TEXT } : {}) }])
  }
  for (let f = 1; f <= 12; f++) {
    await clock.advance(TICK)
    expect(await chips()).toEqual(chip('Read', ramp[[5, 4, 3, 4][f % 4]! - 1]!))
  }
  // Hold (shade 5) and 4 tones down: the chip follows the name.
  for (let k = 1; k <= 6; k++) {
    await clock.advance(TICK)
    expect(await chips()).toEqual(chip('Read', ramp[4]!))
  }
  for (const k of [4, 3]) {
    await clock.advance(TICK)
    expect(await chips()).toEqual(chip('Read', ramp[k - 1]!))
  }
  await clock.advance(2 * TICK)
  expect((await chips())[1]).toEqual({ t: ' Read ', bg: ramp[0] })
  // Settled: the chip is gone with the last tone down (Eduardo, 25/10: it leaves as the next row plays).
  await clock.advance(TICK)
  expect(await chips()).toEqual([])
  await clock.advance(LIT * TICK)
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain(' Read ')
})

const SIX = `sed -i s/a/b/ '${atWsl('wsl-only.md')}'; cat '${atWsl('wsl-only.md')}'; wc -l '${atWsl('wsl-only.md')}'; head '${atWsl('wsl-only.md')}'; tail '${atWsl('wsl-only.md')}'; grep x '${atWsl('wsl-only.md')}'`

test('a Bash of six commands draws four chips and a +2', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: SIX } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  await clock.advance(8 * TICK)
  const segs = afterName(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')
  expect(segs.filter((s: any) => s.bg).map((s: any) => s.t)).toEqual([' sed ', ' cat ', ' wc ', ' head '])
  expect(segs.filter((s: any) => s.bg).length).toBe(4)
  expect(segs[segs.length - 1]).toEqual({ t: ' +2', c: expect.any(String) })
  expect(segs[segs.length - 1].bg).toBeUndefined()
  expect(segs.some((s: any) => s.sh || s.spin)).toBe(false)
})

test('glyphs plain draws the same square chip', { options: { sessionTab: 'off', replayAnimation: 'modern', glyphs: 'plain' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: `sed -i 's/a/b/' '${atWsl('wsl-only.md')}'` } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  await clock.advance(8 * TICK)
  const segs = afterName(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')
  expect(segs.length).toBe(2)
  expect(segs[0]).toEqual({ t: ' ' })
  expect(segs[1].t).toBe(' sed ')
  expect(typeof segs[1].bg).toBe('string')
})

test('classic draws no chip, live or on ▷', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await clock.advance(1_000)
  expect(JSON.stringify(await ui.drawn())).not.toContain(' Read ')
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  for (let i = 0; i < 10; i++) {
    await clock.advance(200)
    expect(JSON.stringify(await ui.drawn())).not.toContain(' Read ')
  }
})

test('liveAnimation instant draws no chip on the lit row', { options: { sessionTab: 'off', replayAnimation: 'modern', liveAnimation: 'instant' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await clock.settle()
  expect(isBright(await specs(ui))).toBe(true)
  expect(JSON.stringify(await ui.drawn())).not.toContain(' Read ')
  expect((await specs(ui)).every((r: any) => r.left.every((s: any) => !s.bg))).toBe(true)
})

test('live: the Read chip shows on the row while its frames play and leaves with them', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  await $.prompt.submit({ text: 'x' } as any)
  const call = read()
  await clock.settle()
  gate.release()
  await call
  // The chip rides the frames: at least once with the icon's tone 5 and dark text.
  let seen = false
  for (let i = 0; i < 40 && !seen; i++) {
    await clock.advance(TICK)
    const segs = afterName(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')
    seen = segs.some((s: any) => s.t === ' Read ' && s.bg === ramp[4] && s.c === DARK_TEXT)
  }
  expect(seen).toBe(true)
  await ticksUntil(clock, ui, rows => isBright(rows))
  // The player idle and the answer still going: the row stays lit, the chip is already gone with its frames.
  await clock.advance(6_000)
  expect(isBright(await specs(ui))).toBe(true)
  expect(afterName(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')).toEqual([])
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain(' Read ')
})

// 25/10, Eduardo on the 0.8.1: "some show up before their time [...] it should show only with that row's
// animation, and on one row at a time". The chip of a row comes with the row's own first tone, never
// while the bar travels to it or while it waits in the queue behind another file.
test('live: a chip comes only with its own row\'s first tone, one row at a time, in the order the files play', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const teal = RAMPS.teal!
  const chipOn = (rows: any[], name: string) => afterName(rowOf(rows, name), name).some((s: any) => s.t === ' sed ')
  const toned = (rows: any[], name: string) => teal.includes(nameSeg(rowOf(rows, name), name)?.c)
  await $.prompt.submit({ text: 'x' } as any)
  const call = $.tool.call({ tool: 'Bash', command: `sed -i s/a/b/ '${atWsl('wsl-only.md')}'; sed -i s/a/b/ '${atWsl('database/schema.sql')}'` } as any)
  await clock.settle()
  gate.release()
  await call
  let first = -1
  let second = -1
  for (let i = 0; i < 120 && second < 0; i++) {
    await clock.advance(TICK)
    const rows = await specs(ui)
    for (const name of ['wsl-only.md', 'database/schema.sql'] as const) {
      const short = name.split('/').pop()!
      // A chip on a row that has no tone of its own yet is a chip before its time.
      if (chipOn(rows, short) && !toned(rows, short)) throw new Error(`chip on ${short} at tick ${i} with no tone on the name`)
    }
    if (first < 0 && chipOn(rows, 'wsl-only.md')) first = i
    if (chipOn(rows, 'schema.sql')) {
      second = i
      expect(first).toBeGreaterThanOrEqual(0)
    }
  }
  expect(first).toBeGreaterThanOrEqual(0)
  expect(second).toBeGreaterThan(first)
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

test('live: a git commit draws its `git commit` chip on the branch row in green', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const green = RAMPS.green!
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = { result: { text: 'ok', isError: false, gitOperation: { commit: { sha: 'abc1234def' } } } }
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: 'git -C /home/user/my-repo add -A && git -C /home/user/my-repo commit -m x' } as any))
  await clock.settle()
  let found: [string, string][] = []
  for (let i = 0; i < 40 && !found.some(([label, bg]) => label === ' git commit ' && green.includes(bg)); i++) {
    await clock.advance(TICK)
    found = branchChips(await ui.drawn())
  }
  expect(found.some(([label, bg]) => label === ' git commit ' && green.includes(bg))).toBe(true)
  expect(found.some(([label, bg]) => label === ' git add ' && green.includes(bg))).toBe(true)
  // The branch has no icon, so no mark: its chips go when its step is over.
  await clock.advance(40 * TICK)
  expect(branchChips(await ui.drawn()).some(([label]) => label === ' git commit ')).toBe(false)
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(branchChips(await ui.drawn()).some(([label]) => label === ' git commit ')).toBe(false)
})

test('a Write that fails records nothing', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  gate.fail = true
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, $.tool.call({ tool: 'Write', file_path: atWsl('wsl-only.md'), content: 'a\nb\nc\nd\ne' } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  for (let i = 0; i < 5; i++) {
    await clock.advance(400)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('" +')
  }
})

// The lit name shimmers one character per Text, so an open folder shows as its ▾ caret.
test('classic opens every folder at once, as it always did', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, lit, read, ui } = await litWorld($, on)
  const rows = async () => JSON.stringify(await ui.drawn({ in: 'rows' }))
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('database\\schema.sql'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'collapse' })
  await clock.advance(10)
  expect(await rows()).not.toContain('▾')
  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  expect(await rows()).toContain('▾')
  expect(await lit('schema.sql')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
})

// The light of today: modern with liveAnimation instant, and classic, light at once.
const INSTANT = [{ liveAnimation: 'instant' }, { replayAnimation: 'classic' }] as const
for (const instant of INSTANT) {
const how = Object.values(instant)[0]
test(`a file lights as the call starts, stays lit between calls, and goes out when the answer ends (${how})`, { options: { sessionTab: 'off', ...instant }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, lit, read } = await litWorld($, on)
  expect(await lit('wsl-only.md')).toBe(false)
  const first = read()
  for (let i = 0; i < 10; i++) await clock.advance(50)
  expect(await lit('wsl-only.md')).toBe(true)
  gate.release()
  await first
  await clock.advance(30_000)
  expect(await lit('wsl-only.md')).toBe(true)
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(await lit('wsl-only.md')).toBe(false)
})

test(`a light lasts at least five seconds, even when the next command or the end of the answer comes sooner (${how})`, { options: { sessionTab: 'off', ...instant }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, lit, read } = await litWorld($, on)
  const first = read()
  await clock.advance(50)
  gate.release()
  await first
  const second = $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await clock.advance(4_000)
  expect(await lit('wsl-only.md')).toBe(true)
  await clock.advance(1_500)
  expect(await lit('wsl-only.md')).toBe(false)
  gate.release()
  await second
  const third = read()
  await clock.advance(50)
  gate.release()
  await third
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(4_000)
  expect(await lit('wsl-only.md')).toBe(true)
  await clock.advance(1_500)
  expect(await lit('wsl-only.md')).toBe(false)
})
}

// 8.2: liveAnimation animated (the default) with modern plays each live light as the short replay of its step.
// The lit row's name carries the tone (sh), dim on a folder the light opened.
// The live light's lit row draws the settled tone of its ramp, bold, where the instant light shimmers.
const SETTLED = new Set(Object.values(RAMPS).map(r => r[1]))
const lightOf = (row: any, name: string): 'bright' | 'dim' | null => {
  const seg = nameSeg(row, name)
  if (!seg?.sh) return seg?.b && SETTLED.has(seg.c) ? 'bright' : null
  return seg.dim ? 'dim' : 'bright'
}
const LIVE_OPTIONS = { sessionTab: 'off', replayAnimation: 'modern' } as const
// A folder on the way to a live-lit file: its child's ramp at the folder tone, bold, never the shimmer.
const DIM_TONE = 2
const liveFolder = (row: any, name: string, ramp: string) => {
  const seg = nameSeg(row, name)
  return !seg?.sh && seg?.c === RAMPS[ramp]![DIM_TONE] && seg?.b === true
}
// Ticks until the row is lit as the instant light lights it, or past the limit.
async function ticksUntil(clock: any, ui: any, done: (rows: any[]) => boolean, limit = 60): Promise<number> {
  let n = 0
  while (!done(await specs(ui)) && n <= limit) {
    await clock.advance(TICK)
    n++
  }
  return n
}

test('live: a Read in a closed folder sets the bar out on it at once and ends lit as the light of today leaves it', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  const call = read('database\\schema.sql')
  await clock.settle()
  // Tick 1: the bar is on the folder, still shut.
  expect(barOf(await specs(ui))).toMatch(/\/database$/)
  expect(rowOf(await specs(ui), 'schema.sql')).toBe(undefined)
  gate.release()
  await call
  const n = await ticksUntil(clock, ui, rows => lightOf(rowOf(rows, 'schema.sql'), 'schema.sql') === 'bright')
  expect(n).toBeLessThanOrEqual(30)
  const rows = await specs(ui)
  expect(liveFolder(rowOf(rows, 'database'), 'database', 'purple')).toBe(true)
  expect(JSON.stringify(rows)).toContain('▾')
  // The bar stays on the file it lit.
  expect(barOf(rows)).toMatch(/\/schema\.sql$/)
})

test('live: tool.call answers before the first tick of its animation', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const call = read('database\\schema.sql')
  let done = false
  void call.then(() => (done = true))
  await clock.settle()
  gate.release()
  await clock.settle()
  expect(done).toBe(true)
  // No tick went by: the bar is still on its first frame.
  expect(barOf(await specs(ui))).toMatch(/\/database$/)
  expect(rowOf(await specs(ui), 'schema.sql')).toBe(undefined)
})

test('live: a second Edit two ticks after the first plays in CATCH, lit at most 10 ticks after the first', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const edit = (name: string) => $.tool.call({ tool: 'Edit', file_path: atWsl(name), old_string: 'two', new_string: 'two\ntres' } as any)
  await $.prompt.submit({ text: 'x' } as any)
  const first = edit('wsl-only.md')
  await clock.settle()
  gate.release()
  await first
  await clock.advance(2 * TICK)
  const second = edit('database\\schema.sql')
  await clock.settle()
  gate.release()
  await second
  const n = await ticksUntil(clock, ui, rows => lightOf(rowOf(rows, 'wsl-only.md'), 'wsl-only.md') === 'bright')
  expect(n).toBeGreaterThan(0)
  expect(n).toBeLessThanOrEqual(30)
  const m = await ticksUntil(clock, ui, rows => lightOf(rowOf(rows, 'schema.sql'), 'schema.sql') === 'bright')
  expect(m).toBeGreaterThan(0)
  expect(m).toBeLessThanOrEqual(10)
  expect(lightOf(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')).toBe('bright')
  expect(liveFolder(rowOf(await specs(ui), 'database'), 'database', 'orange')).toBe(true)
})

// The tick each name first draws lit (bright), or -1 past the limit.
async function litTicks(clock: any, ui: any, names: string[], limit: number): Promise<number[]> {
  const at = names.map(() => -1)
  for (let n = 0; n <= limit && at.includes(-1); n++) {
    const rows = await specs(ui)
    names.forEach((name, i) => {
      if (at[i] === -1 && lightOf(rowOf(rows, name), name) === 'bright') at[i] = n
    })
    await clock.advance(TICK)
  }
  return at
}
// One shell command reading these files of the repo's root, all in one light.
const catAll = ($: any, names: string[]) => $.tool.call({ tool: 'Bash', command: `cat ${names.map(name => `//wsl.localhost/Ubuntu/home/user/my-repo/${name}`).join(' ')}` } as any)
const runOf = async (ui: any) => JSON.stringify(await ui.drawn()).match(/▸ (\d+) of (\d+)/)?.slice(1).map(Number) ?? null

test('live: eight Reads at once play one at a time, each on its own tick, all lit within 80 ticks', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    const names = MANY.slice(0, 8).map(([name]) => name)
    await $.prompt.submit({ text: 'x' } as any)
    const calls = names.map(name => read(name))
    await clock.settle()
    gate.release()
    await Promise.all(calls)
    const at = await litTicks(clock, ui, names, 80)
    expect(at.every(n => n >= 0)).toBe(true)
    // In the order they came, never two on the same tick.
    for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('live: one command reading three files plays them one at a time in order, with the ▸ count until the queue drains', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const names = MANY.slice(0, 3).map(([name]) => name)
    await $.prompt.submit({ text: 'x' } as any)
    const call = catAll($, names)
    await clock.settle()
    gate.release()
    await call
    await clock.settle()
    // The first plays, none lit yet: the count says 1 of 3.
    expect(await runOf(ui)).toEqual([1, 3])
    const first = await specs(ui)
    expect(names.filter(name => lightOf(rowOf(first, name), name) === 'bright')).toEqual([])
    const at = await litTicks(clock, ui, names, 60)
    expect(at.every(n => n >= 0)).toBe(true)
    expect(at[1]!).toBeGreaterThan(at[0]!)
    expect(at[2]!).toBeGreaterThan(at[1]!)
    await clock.advance(TICK)
    expect(await runOf(ui)).toBe(null)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('live: with 8 or more files waiting the next plays in RUSH, faster than CATCH', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const names = MANY.slice(0, 12).map(([name]) => name)
    await $.prompt.submit({ text: 'x' } as any)
    const call = catAll($, names)
    await clock.settle()
    gate.release()
    await call
    const at = await litTicks(clock, ui, names, 120)
    expect(at.every(n => n >= 0)).toBe(true)
    const rush = 1 + RUSH.rampUp + RUSH.iconTicks + RUSH.rampDown
    const caught = 1 + CATCH.rampUp + CATCH.iconTicks + CATCH.rampDown
    // 12, 11, 10, 9 and 8 waiting: RUSH; the last ones, 2 to 7 waiting: CATCH.
    expect(at[1]! - at[0]!).toBeLessThanOrEqual(rush + 1)
    expect(at[11]! - at[10]!).toBeGreaterThanOrEqual(caught - 1)
    expect(rush).toBeLessThan(caught)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('live: past 30 waiting the oldest light at once with no frames, and the animation goes on from the next', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const many: [string, 'file'][] = Array.from({ length: 40 }, (_, i) => [`b${String(i).padStart(2, '0')}.md`, 'file'])
  DIRS[WSL_ROOT] = [...root, ...many]
  try {
    const { clock, gate, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 60 } })
    const names = many.map(([name]) => name)
    await $.prompt.submit({ text: 'x' } as any)
    const call = catAll($, names)
    await clock.settle()
    gate.release()
    await call
    await clock.settle()
    // No tick went by: the 10 oldest are lit in their settled tone, the 11th is where the bar goes.
    const rows = await specs(ui)
    expect(names.slice(0, 10).every(name => lightOf(rowOf(rows, name), name) === 'bright')).toBe(true)
    expect(nameSeg(rowOf(rows, 'b00.md'), 'b00.md').c).toBe(RAMPS.purple![1])
    expect(lightOf(rowOf(rows, 'b10.md'), 'b10.md')).toBe(null)
    expect(barOf(rows)).toMatch(/\/b10\.md$/)
    expect(await runOf(ui)).toEqual([11, 40])
    const at = await litTicks(clock, ui, names.slice(10, 12), 30)
    expect(at[0]!).toBeGreaterThan(0)
    expect(at[1]!).toBeGreaterThan(at[0]!)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('rows draw each lit segment in one Text once the lit characters pass 1500', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const many: [string, 'file'][] = Array.from({ length: 50 }, (_, i) => [`relatorio-trimestral-numero-${String(i).padStart(2, '0')}.md`, 'file'])
  DIRS[WSL_ROOT] = [...root, ...many]
  try {
    const { clock, gate, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 80 } })
    const names = many.map(([name]) => name)
    await $.prompt.submit({ text: 'x' } as any)
    const call = catAll($, names)
    await clock.settle()
    gate.release()
    await call
    await clock.settle()
    const rows = await specs(ui)
    const lit = rows.flatMap(r => [...r.left, ...r.right]).filter((x: any) => x.sh)
    expect(lit.reduce((n: number, x: any) => n + x.t.length, 0)).toBeGreaterThan(1500)
    // Lit, and still drawn whole: one Text, not one per character.
    expect(nameSeg(rowOf(rows, names[0]!), names[0]!).sh).toBeTruthy()
    const drawn = JSON.stringify(await ui.drawn({ in: 'rows' }))
    expect(names.every(name => drawn.includes(name))).toBe(true)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// On the desktop the pane draws in its own window only while live frames play: with the player idle it draws
// every row again with no scrollbar of its own (the engine scrolls the body), the bar still parked on its file.
test('live: on the desktop the pane is back on native scroll once the step is done, with the bar still on its file', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...MANY]
  try {
    const { clock, gate, read, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 12 } })
    const all = MANY.length + root.length
    const own = async () => clientOf(await ui.drawn()).props.props.bar !== undefined
    await $.prompt.submit({ text: 'x' } as any)
    expect((await specs(ui)).length).toBe(all)
    expect(await own()).toBe(false)
    const call = read('a15.md')
    await clock.settle()
    gate.release()
    await call
    await clock.advance(TICK)
    expect((await specs(ui)).length).toBeLessThan(all)
    expect(await own()).toBe(true)
    await ticksUntil(clock, ui, rows => lightOf(rowOf(rows, 'a15.md'), 'a15.md') === 'bright')
    await clock.advance(TICK)
    const rows = await specs(ui)
    expect(rows.length).toBe(all)
    expect(await own()).toBe(false)
    expect(barOf(rows)).toMatch(/\/a15\.md$/)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// B1 with the live light: the second Read came while the first was still on its way to open the folder.
// For the replay the folder was open, as the light of today leaves it, so step 2 does not shut it again.
test('live: a Read into the folder the step before is still opening replays with the folder open', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[`${WSL_ROOT}/database`]!
  DIRS[`${WSL_ROOT}/database`] = [['a.sql', 'file'], ...db]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    await $.prompt.submit({ text: 'x' } as any)
    for (const name of ['database\\a.sql', 'database\\schema.sql']) {
      const call = read(name)
      await clock.settle()
      gate.release()
      await call
    }
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10_000)
    await ui.press({ key: 'replay-last' })
    let n = 0
    while (!JSON.stringify(await ui.drawn()).includes('■ 2/2') && n++ < 80) await clock.advance(TICK)
    expect(JSON.stringify(await ui.drawn())).toContain('■ 2/2')
    expect(rowOf(await specs(ui), 'a.sql')).not.toBe(undefined)
  } finally {
    DIRS[`${WSL_ROOT}/database`] = db
  }
})

// The same command and the same end of the answer, with the light of today and with the live one:
// 10 ticks after the end the tab is the same, and it goes out on the same clock.
const stopDrawn: Record<string, string[]> = {}
for (const liveAnimation of ['instant', 'animated'] as const) {
  test(`classic.Stop on tick 3 of a live step leaves the tab as lightUp and unlight do (${liveAnimation})`, { options: { ...LIVE_OPTIONS, liveAnimation }, timeoutMs: 30_000 }, async ($, on) => {
    const { clock, gate, read, ui } = await litWorld($, on)
    // A button's handle is new on each draw.
    const drawn = async () => (JSON.stringify(await ui.drawn()) + JSON.stringify(await ui.drawn({ in: 'rows' }))).replace(/"handle":\d+/g, '')
    await $.prompt.submit({ text: 'x' } as any)
    const call = read('database\\schema.sql')
    await clock.settle()
    gate.release()
    await call
    await clock.advance(3 * TICK)
    if (liveAnimation === 'animated') {
      // Mid step: the bar on its way, the file not lit yet.
      expect(barOf(await specs(ui))).not.toBe(null)
      expect(lightOf(rowOf(await specs(ui), 'schema.sql'), 'schema.sql')).toBe(null)
    }
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(10 * TICK)
    const rows = await specs(ui)
    expect(barOf(rows)).toBe(null)
    expect(lightOf(rowOf(rows, 'schema.sql'), 'schema.sql')).toBe('bright')
    if (liveAnimation === 'animated') expect(liveFolder(rowOf(rows, 'database'), 'database', 'purple')).toBe(true)
    else expect(lightOf(rowOf(rows, 'database'), 'database')).toBe('dim')
    const lit = await drawn()
    await clock.advance(5_000)
    const out = await drawn()
    expect(lightOf(rowOf(await specs(ui), 'schema.sql'), 'schema.sql')).toBe(null)
    await clock.advance(5_000)
    expect(await drawn()).toBe(out)
    stopDrawn[liveAnimation] = [lit, out]
    // Lit, the live light keeps its ramps where the instant light shimmers; out, the tab is the same.
    if (liveAnimation === 'animated') expect(stopDrawn.animated![1]).toEqual(stopDrawn['instant']![1])
  })
}

test('live: ▷ in the middle of a live step starts the replay on the next tick and leaves no light half way', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const drawn = async () => JSON.stringify(await ui.drawn())
  const tones = (rows: any[]) => rows.filter(r => r.left.some((s: any) => s.sh)).length
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, read('wsl-only.md'))
  const second = read('database\\schema.sql')
  await clock.settle()
  gate.release()
  await second
  await clock.advance(TICK)
  expect(barOf(await specs(ui))).not.toBe(null)
  expect(lightOf(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md')).toBe(null)
  await ui.press({ key: 'replay-last' })
  expect(await drawn()).toContain('■ 1/2')
  expect(tones(await specs(ui))).toBe(0)
  await clock.advance(TICK)
  expect(await drawn()).toContain('■ 1/2')
  expect(tones(await specs(ui))).toBe(0)
  await clock.advance(10_000)
  expect(await drawn()).not.toContain('replay-stop')
  expect(barOf(await specs(ui))).toBe(null)
  expect(tones(await specs(ui))).toBe(0)
  const after = await drawn()
  await clock.advance(5_000)
  expect(await drawn()).toBe(after)
})

// 8.4: once its frames are done, the step's icon stays on the row as a still mark in tone 3, with no dots,
// for as long as the row's light is on. It goes with the light: the fade at the end of the answer, or ▷.
const markOf = async (ui: any, name = 'wsl-only.md') => glyphSeg(rowOf(await specs(ui), name), name)
const isBright = (rows: any[], name = 'wsl-only.md') => lightOf(rowOf(rows, name), name) === 'bright'

test('live: the ⌕ stays on the lit row after its frames, still in tone 3, and leaves with the light at the end of the answer', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  await $.prompt.submit({ text: 'x' } as any)
  const call = read()
  await clock.settle()
  gate.release()
  await call
  const n = await ticksUntil(clock, ui, rows => isBright(rows))
  expect(n).toBeLessThanOrEqual(30)
  expect(await markOf(ui)).toEqual({ t: '⌕ ', c: ramp[2] })
  // The player idle and the answer still going: the mark stays, still.
  await clock.advance(6_000)
  expect(isBright(await specs(ui))).toBe(true)
  expect(await markOf(ui)).toEqual({ t: '⌕ ', c: ramp[2] })
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(isBright(await specs(ui))).toBe(false)
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('⌕')
})

// Rodada 4: once its frames are done, the live row's name keeps the settled tone of its ramp, bold, with no shimmer,
// and the mark beside it in tone 3 of the same ramp, until the light goes out.
test('live: the lit name keeps tone 2 of its ramp after the frames, never the instant light shimmer', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const ramp = RAMPS.purple!
  await $.prompt.submit({ text: 'x' } as any)
  const call = read()
  await clock.settle()
  gate.release()
  await call
  await ticksUntil(clock, ui, rows => isBright(rows))
  await clock.advance(6_000)
  const row = rowOf(await specs(ui), 'wsl-only.md')
  const name = nameSeg(row, 'wsl-only.md')
  expect(name.sh).toBeUndefined()
  expect(name.c).toBe(ramp[1])
  expect(name.b).toBe(true)
  expect(glyphSeg(row, 'wsl-only.md')).toEqual({ t: '⌕ ', c: ramp[2] })
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(nameSeg(rowOf(await specs(ui), 'wsl-only.md'), 'wsl-only.md').c).not.toBe(ramp[1])
})

// Rodada 5: an Edit lights as its call starts, before its counts; it plays as an edit (✎, orange) from the first
// frame, and keeps it when its result comes in after the frames are done.
test('live: an Edit whose result comes after its frames plays and stays ✎ orange, never the shell >', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const ramp = RAMPS.orange!
  await $.prompt.submit({ text: 'x' } as any)
  const call = $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'two\ntres' } as any)
  await clock.settle()
  const n =await ticksUntil(clock, ui, rows => isBright(rows))
  expect(n).toBeLessThanOrEqual(40)
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('"> "')
  expect(await markOf(ui)).toEqual({ t: '✎ ', c: ramp[2] })
  gate.release()
  await call
  await clock.settle()
  const row = rowOf(await specs(ui), 'wsl-only.md')
  expect(glyphSeg(row, 'wsl-only.md')).toEqual({ t: '✎ ', c: ramp[2] })
  expect(nameSeg(row, 'wsl-only.md').c).toBe(ramp[1])
})

test('live: a second step on the same file replaces its mark, ⌕ after the Read and ✎ after the Edit', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  const first = read()
  await clock.settle()
  gate.release()
  await first
  await ticksUntil(clock, ui, rows => isBright(rows))
  expect(await markOf(ui)).toEqual({ t: '⌕ ', c: RAMPS.purple![2] })
  const second = $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'two\ntres' } as any)
  await clock.settle()
  gate.release()
  await second
  const m = await ticksUntil(clock, ui, rows => isBright(rows) && glyphSeg(rowOf(rows, 'wsl-only.md'), 'wsl-only.md')?.t === '✎ ')
  expect(m).toBeLessThanOrEqual(30)
  const row = rowOf(await specs(ui), 'wsl-only.md')
  expect(glyphSeg(row, 'wsl-only.md')).toEqual({ t: '✎ ', c: RAMPS.orange![2] })
  expect(nameSeg(row, 'wsl-only.md').t).toBe('wsl-only.md')
})

test('live: ▷ while the player is parked takes the marks with it', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  const call = read()
  await clock.settle()
  gate.release()
  await call
  await ticksUntil(clock, ui, rows => isBright(rows))
  expect((await markOf(ui)).t).toBe('⌕ ')
  await ui.press({ key: 'replay-last' })
  expect(JSON.stringify(await ui.drawn())).toContain('■ 1/1')
  expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('⌕')
})

for (const instant of INSTANT) {
  const how = Object.values(instant)[0]
  test(`the instant light draws no mark on the lit row (${how})`, { options: { sessionTab: 'off', replayAnimation: 'modern', ...instant }, timeoutMs: 30_000 }, async ($, on) => {
    const { clock, gate, read, ui } = await litWorld($, on)
    await command(clock, gate, read())
    await clock.settle()
    expect(isBright(await specs(ui))).toBe(true)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).not.toContain('⌕')
  })
}

const CARD = 'trail-card'
const NEW_FILE = 'C:\\Users\\user\\Documents\\Code\\other\\new.md'

async function until(clock: any, ok: () => boolean) {
  for (let i = 0; i < 40 && !ok(); i++) {
    for (const step of waits.splice(0)) step()
    await clock.advance(300)
  }
}

// opening auto (the default): the first edit in a repo opens its tab, with no card.
async function autoWorld($: any, on: any, cwd: string, noGit = false) {
  const opens: any[] = []
  const clock = world(on, [], opens, noGit)
  on('session.root', () => ({ value: cwd }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const edit = async (file_path: string) => {
    let result: any
    const call = $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string: 'y' } as any).then((r: any) => (result = r))
    await until(clock, () => result !== undefined)
    // A call still held (on a card) is left behind, so the test fails instead of hanging.
    if (result !== undefined) await call
    return result
  }
  return { opens, clock, edit }
}

test('an Edit in a git repo with no tab opens the tab by itself, with no card', { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const { opens, edit } = await autoWorld($, on, 'C:/Users/user/Documents/Code/project')
  const result = await edit(NEW_FILE)
  const tab = paneId(`win:${WIN_ROOT}`)
  expect(opens.some(o => o.id === CARD)).toBe(false)
  expect(opens.some(o => o.id === tab)).toBe(true)
  expect(result?.deny).toBe(undefined)
  expect(JSON.stringify(result)).toContain('ok')
})

test('a tab the person closed comes back on the next edit', { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const { opens, clock, edit } = await autoWorld($, on, 'C:/Users/user/Documents/Code/project')
  const tab = paneId(`win:${WIN_ROOT}`)
  await edit(NEW_FILE)
  expect(opens.filter(o => o.id === tab).length).toBe(1)
  // The test's $ has no ui.close (a person's close is the engine's to raise): close closes it the same way.
  await $.command.run({ ...openCmd(''), args: `close ${WIN_ROOT}` })
  await clock.settle()
  await edit(NEW_FILE)
  expect(opens.filter(o => o.id === tab).length).toBe(2)
  expect(opens.some(o => o.id === CARD)).toBe(false)
})

test('the session repo tab also comes back after being closed', { timeoutMs: 30_000 }, async ($, on) => {
  const { opens, clock, edit } = await autoWorld($, on, WIN_ROOT)
  const tab = paneId(`win:${WIN_ROOT}`)
  expect(opens.map(o => o.id)).toEqual([tab])
  // The test's $ has no ui.close (a person's close is the engine's to raise): close closes it the same way.
  await $.command.run({ ...openCmd(''), args: `close ${WIN_ROOT}` })
  await clock.settle()
  await edit(`${WIN_ROOT}/win-only.md`)
  expect(opens.filter(o => o.id === tab).length).toBe(2)
})

test('a Read in a git repo with no tab opens the tab too, reads being on by default', { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const { opens, clock } = await autoWorld($, on, 'C:/Users/user/Documents/Code/project')
  const tab = paneId(`win:${WIN_ROOT}`)
  let result: any
  void $.tool.call({ tool: 'Read', file_path: NEW_FILE } as any).then((r: any) => (result = r))
  await until(clock, () => result !== undefined)
  expect(opens.some(o => o.id === CARD)).toBe(false)
  expect(opens.filter(o => o.id === tab).length).toBe(1)
  expect(JSON.stringify(result)).toContain('ok')
})

test('with reads no, a Read opens nothing', { options: { sessionTab: 'off', reads: 'no' }, timeoutMs: 30_000 }, async ($, on) => {
  const { opens, clock } = await autoWorld($, on, 'C:/Users/user/Documents/Code/project')
  let result: any
  void $.tool.call({ tool: 'Read', file_path: NEW_FILE } as any).then((r: any) => (result = r))
  await until(clock, () => result !== undefined)
  expect(opens.length).toBe(0)
})

test('an Edit outside any git repo opens nothing', { options: { sessionTab: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
  const { opens, edit } = await autoWorld($, on, 'C:/Users/user/Documents/Code/project', true)
  const result = await edit('C:\\Users\\user\\Downloads\\a.txt')
  expect(JSON.stringify(result)).toContain('ok')
  expect(opens.length).toBe(0)
})

test('with opening card the card behaves as before', { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens)
  on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  let result: any
  const call = $.tool.call({ tool: 'Edit', file_path: NEW_FILE, old_string: 'x', new_string: 'y' } as any).then(r => (result = r))
  await until(clock, () => opens.some(o => o.id === CARD))
  expect(opens.some(o => o.id === CARD)).toBe(true)
  expect(opens.some(o => o.id === paneId(`win:${WIN_ROOT}`))).toBe(false)
  const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: CARD, props })
  await ui.press({ key: 'cancel' })
  await until(clock, () => result !== undefined)
  await call
  expect(JSON.stringify(result)).toContain('denied on the card')
})

for (const choice of ['allow', 'cancel'] as const) {
  test(`a write in a repo outside the session holds on the card until ${choice}`, { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
    const opens: any[] = []
    const closes: string[] = []
    const ran: string[][] = []
    const clock = world(on, ran, opens)
    on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
    on('ui.close', (_$: any, e: any) => {
      closes.push(e.id)
      return { value: undefined }
    })
    on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
    await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
    await clock.settle()
    let result: any
    const call = $.tool.call({ tool: 'Write', file_path: NEW_FILE, content: 'x' } as any).then(r => (result = r))
    await until(clock, () => opens.some(o => o.id === CARD))
    expect(opens.find(o => o.id === CARD)?.focus).toBe(true)
    const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: CARD, props })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('C:/Users/user/Documents/Code/other')
    expect(drawn).toContain('Write')
    await ui.press({ key: choice })
    await until(clock, () => result !== undefined)
    await call
    expect(closes).toContain(CARD)
    const tab = paneId(`win:${WIN_ROOT}`)
    if (choice === 'allow') {
      expect(JSON.stringify(result)).toContain('ok')
      expect(opens.some(o => o.id === tab)).toBe(true)
      // The tab must not keep the keys, or the next card's focus is refused and it waits behind it unseen.
      expect(opens.filter(o => o.id === tab).some(o => o.focus)).toBe(false)
      // The second write in the same repo passes with no card.
      const before = opens.filter(o => o.id === CARD).length
      await $.tool.call({ tool: 'Edit', file_path: NEW_FILE, old_string: 'x', new_string: 'y' } as any)
      await clock.settle()
      expect(opens.filter(o => o.id === CARD).length).toBe(before)
    } else {
      expect(JSON.stringify(result)).toContain(`trail: access to ${WIN_ROOT} denied on the card`)
      expect(opens.some(o => o.id === tab)).toBe(false)
    }
  })
}

test('a card left behind another tab is drawn above the prompt too', { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens)
  on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as any)
  git.front = 'other-tab'
  try {
    await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
    await clock.settle()
    let result: any
    const call = $.tool.call({ tool: 'Write', file_path: NEW_FILE, content: 'x' } as any).then(r => (result = r))
    await until(clock, () => opens.some(o => o.id === CARD))
    await until(clock, () => false)
    const band = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'AbovePrompt', props: {} as any })
    expect(JSON.stringify(await band.drawn())).toContain('C:/Users/user/Documents/Code/other')
    await band.press({ key: 'cancel' })
    await until(clock, () => result !== undefined)
    await call
    expect(JSON.stringify(result)).toContain('denied on the card')
  } finally {
    git.front = ''
  }
})

for (const [isFullscreen, columns, card] of [[true, 107, true], [false, 200, false]] as const) {
  test(`terminal ${isFullscreen ? 'fullscreen' : 'main screen'} at ${columns} columns ${card ? 'shows' : 'shows no'} card`, { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
    const opens: any[] = []
    git.surface = 'terminal'
    try {
      const clock = world(on, [], opens)
      on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
      on('ui.close', () => ({ value: undefined }))
      on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
      on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as any)
      await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'terminal', isInteractive: true })
      await clock.settle()
      // The chat column the terminal reports once the session's own tab docks beside it.
      const seen = await $.ui.mount({ plugin: 'trail', surface: 'terminal', component: 'AbovePrompt', props: {} as any, viewport: { columns, rows: 50, isFullscreen } as any })
      await seen.drawn()
      let result: any
      const call = $.tool.call({ tool: 'Write', file_path: NEW_FILE, content: 'x' } as any).then(r => (result = r))
      await until(clock, () => result !== undefined || opens.some(o => o.id === CARD))
      expect(opens.some(o => o.id === CARD)).toBe(card)
      if (card) {
        const ui = await $.ui.mount({ plugin: 'trail', surface: 'terminal', component: 'Pane', requestId: CARD, props })
        await ui.press({ key: 'cancel' })
      }
      await until(clock, () => result !== undefined)
      await call
    } finally {
      git.surface = 'desktop'
    }
  })
}

test('a write outside any git repo, or inside the session, shows no card', { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens, true)
  on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  let result: any
  const call = $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\user\\Downloads\\a.txt', content: 'x' } as any).then(r => (result = r))
  await until(clock, () => result !== undefined)
  await call
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\user\\Documents\\Code\\project\\a.md', content: 'x' } as any)
  expect(JSON.stringify(result)).toContain('ok')
  expect(opens.length).toBe(0)
})

test('"Don\'t ask again" opens the tab with no card until /trail forget', { options: { sessionTab: 'off', opening: 'card' }, timeoutMs: 30_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens)
  on('session.root', () => ({ value: 'C:/Users/user/Documents/Code/project' }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const cards = () => opens.filter(o => o.id === CARD).length
  const write = async () => {
    let result: any
    const before = cards()
    const call = $.tool.call({ tool: 'Write', file_path: NEW_FILE, content: 'x' } as any).then(r => (result = r))
    await until(clock, () => result !== undefined || cards() > before)
    return { call, done: () => result !== undefined }
  }
  const first = await write()
  expect(cards()).toBe(1)
  const ui = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: CARD, props })
  await ui.press({ key: 'always' })
  await ui.unmount()
  await until(clock, first.done)
  await first.call
  const tab = paneId(`win:${WIN_ROOT}`)
  const drawnTab = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: tab, props })
  expect(JSON.stringify(await drawnTab.drawn())).toContain('C:\\\\Users\\\\user\\\\Documents\\\\Code\\\\other')
  expect(JSON.stringify(await $.command.run(openCmd('')))).toContain("don't ask again")

  await $.command.run({ ...openCmd(''), args: `close ${WIN_ROOT}` })
  const again = await write()
  await until(clock, again.done)
  await again.call
  expect(cards()).toBe(1)
  expect(opens.filter(o => o.id === tab).length).toBeGreaterThan(1)

  await $.command.run({ ...openCmd(''), args: `close ${WIN_ROOT}` })
  expect(JSON.stringify(await $.command.run({ ...openCmd(''), args: 'forget other' }))).toContain('Forgot')
  const third = await write()
  expect(cards()).toBe(2)
  const ui3 = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: CARD, props })
  await ui3.press({ key: 'cancel' })
  await until(clock, third.done)
  await third.call
})

// The rows the Client draws. The typing panel (gone in 0.5.0) drew rows with id '' under the file's row.
function clientRows(node: any): any[] | null {
  return clientOf(node)?.props?.props?.rows ?? null
}

function clientOf(node: any): any {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'Client') return node
  for (const kid of Array.isArray(node) ? node : (node.children ?? [])) {
    const found = clientOf(kid)
    if (found) return found
  }
  return null
}

test('the modern replay of an Edit draws no row with an empty id under the file', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(clock, gate, $.tool.call({ tool: 'Edit', file_path: atWsl('wsl-only.md'), old_string: 'two', new_string: 'alpha\nbeta\ngama\ndelta' } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  await ui.press({ key: 'replay-last' })
  // Sample the whole step (arrive 800 + counters 900 + hold 300), where the panel used to type.
  let seen = 0
  for (let t = 0; t < 2_000; t += 100) {
    await clock.advance(100)
    const rows = clientRows(await ui.drawn()) ?? []
    const at = rows.findIndex((r: any) => r.id.endsWith('/wsl-only.md'))
    if (at < 0) continue
    seen++
    expect(rows.slice(at + 1).filter((r: any) => r.id === '')).toEqual([])
  }
  expect(seen).toBeGreaterThan(0)
  expect(JSON.stringify(await ui.drawn())).not.toContain('■ 1/1')
})


// Rodada 7: the answer ends less than five seconds after the light; the file and its folders keep their ramps
// to the end of the light, with no shimmer, and then go out.
test('live: the end of the answer keeps the lit file and its folders in their ramps, never the shimmer', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  const call = read('database\\schema.sql')
  await clock.settle()
  gate.release()
  await call
  await ticksUntil(clock, ui, rows => lightOf(rowOf(rows, 'schema.sql'), 'schema.sql') === 'bright')
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  const rows = await specs(ui)
  expect(rows.some(r => [...r.left, ...r.right].some((x: any) => x.sh))).toBe(false)
  expect(nameSeg(rowOf(rows, 'schema.sql'), 'schema.sql').c).toBe(RAMPS.purple![1])
  expect(liveFolder(rowOf(rows, 'database'), 'database', 'purple')).toBe(true)
  await clock.advance(5_000)
  expect(lightOf(rowOf(await specs(ui), 'schema.sql'), 'schema.sql')).toBe(null)
  expect(liveFolder(rowOf(await specs(ui), 'database'), 'database', 'purple')).toBe(false)
})

// Rodada 7, passo 5: a Write of a new file has no row when the call starts; it plays once its row is in,
// up the green ramp with the + icon, and keeps + in tone 3 and the name in tone 2.
test('live: a Write of a new file plays the green ramp and the + icon once its row is in', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const ramp = RAMPS.green!
    await $.prompt.submit({ text: 'x' } as any)
    const call = $.tool.call({ tool: 'Write', file_path: atWsl('new.md'), content: 'a\nb\nc' } as any)
    await clock.advance(50)
    DIRS[WSL_ROOT] = [...root, ['new.md', 'file']]
    git.wslStatus = `${WSL_STATUS}?? new.md\0`
    gate.release()
    await call
    const tones = new Set<string>()
    let plus = false
    for (let i = 0; i < 40; i++) {
      await clock.advance(TICK)
      const row = rowOf(await specs(ui), 'new.md')
      if (nameSeg(row, 'new.md')?.c) tones.add(nameSeg(row, 'new.md').c)
      if (glyphSeg(row, 'new.md')?.t === '+ ') plus = true
    }
    expect([ramp[0], ramp[1], ramp[2], ramp[3]].every(c => tones.has(c!))).toBe(true)
    expect(plus).toBe(true)
    const row = rowOf(await specs(ui), 'new.md')
    expect(glyphSeg(row, 'new.md')).toEqual({ t: '+ ', c: ramp[2] })
    expect(nameSeg(row, 'new.md').c).toBe(ramp[1])
  } finally {
    DIRS[WSL_ROOT] = root
    git.wslStatus = WSL_STATUS
  }
})

// 0.7.3: a loop names its files through a variable. The folder it writes in is listed before and after the command,
// and each file that came plays live as born, one step each, in order, as the same files spelled out do.
test('live: a shell loop writing through a variable plays each new file as born, one step each, in order', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const batch = `${WSL_ROOT}/batch`
  const names = ['new-01.txt', 'new-02.txt', 'new-03.txt']
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const ramp = RAMPS.green!
    await $.prompt.submit({ text: 'x' } as any)
    const call = $.tool.call({ tool: 'Bash', command: `cd ${WSL_ROOT} && mkdir -p batch && for i in 01 02 03; do echo "file $i" > batch/new-$i.txt; done` } as any)
    await clock.advance(50)
    DIRS[WSL_ROOT] = [...root, ['batch', 'dir']]
    DIRS[batch] = names.map(name => [name, 'file'])
    gate.release()
    await call
    await clock.settle()
    expect(await runOf(ui)).toEqual([1, 3])
    const at = await litTicks(clock, ui, names, 90)
    expect(at.every(n => n >= 0)).toBe(true)
    expect(at[1]!).toBeGreaterThan(at[0]!)
    expect(at[2]!).toBeGreaterThan(at[1]!)
    const rows = await specs(ui)
    for (const name of names) {
      expect(glyphSeg(rowOf(rows, name), name)).toEqual({ t: '+ ', c: ramp[2] })
      expect(nameSeg(rowOf(rows, name), name).c).toBe(ramp[1])
    }
  } finally {
    DIRS[WSL_ROOT] = root
    delete DIRS[batch]
  }
})

// 0.7.3: an rm of files plays each live as gone, one step each: × and the red ramp on its row, which stays drawn
// (a struck ghost once the tree lost it) through its frames and leaves at its end, one after the other. Spelled out,
// the early light already plays them as gone; as a glob, the folder's diff finds them.
const three = MANY.slice(0, 3)
const threeNames = three.map(([name]) => name)
for (const [how, command] of [['spelled out', `rm ${threeNames.map(name => `'${atWsl(name)}'`).join(' ')}`], ['as a glob', `rm ${WSL_ROOT}/a0*.md`]] as const)
test(`live: an rm of three files ${how} plays three gone steps, each row kept as a ghost through its frames and gone after`, { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const names = threeNames
  DIRS[WSL_ROOT] = [...root, ...three]
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const red = new Set(RAMPS.red!)
    await $.prompt.submit({ text: 'x' } as any)
    const call = $.tool.call({ tool: 'Bash', command } as any)
    await clock.advance(50)
    DIRS[WSL_ROOT] = root
    gate.release()
    await call
    await clock.settle()
    // The tree lost the three rows; the player still draws them, struck, in their old place.
    const first = await specs(ui)
    for (const name of names) {
      expect(rowOf(first, name)?.id).toBe('')
      expect(nameSeg(rowOf(first, name), name).s).toBe(true)
    }
    expect(await runOf(ui)).toEqual([1, 3])
    const seen = names.map(() => ({ cross: false, red: false, left: -1 }))
    for (let n = 0; n <= 120 && seen.some(x => x.left < 0); n++) {
      const rows = await specs(ui)
      names.forEach((name, i) => {
        const row = rowOf(rows, name)
        if (!row) {
          if (seen[i]!.left < 0) seen[i]!.left = n
          return
        }
        expect(seen[i]!.left).toBe(-1)
        if (glyphSeg(row, name)?.t === '× ') seen[i]!.cross = true
        if (red.has(nameSeg(row, name)?.c)) seen[i]!.red = true
      })
      await clock.advance(TICK)
    }
    expect(seen.every(x => x.cross && x.red && x.left > 0)).toBe(true)
    expect(seen[1]!.left).toBeGreaterThan(seen[0]!.left)
    expect(seen[2]!.left).toBeGreaterThan(seen[1]!.left)
    // Gone for good: no row, no ghost, nothing lit in their place.
    await clock.advance(10 * TICK)
    const rows = await specs(ui)
    expect(names.every(name => rowOf(rows, name) === undefined)).toBe(true)
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

// Rodada 7, passo 6: Git Bash names a Windows repo as /c/..., and a cd before a relative path; the tab behind
// comes to the front before the light, and the command is scanned (git status runs) as one naming C:/... is.
test('a Git Bash cd /c/... && rm in the tab behind brings it to the front and scans it', { options: { sessionTab: 'off' }, timeoutMs: 20_000 }, async ($, on) => {
  const opens: any[] = []
  const ran: string[][] = []
  const clock = world(on, ran, opens)
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run(openCmd(WIN_ROOT))
  await $.command.run(openCmd(WSL_ROOT))
  await clock.settle()
  const before = opens.length
  const ranBefore = ran.length
  await $.tool.call({ tool: 'Bash', command: 'cd /c/Users/user/Documents/Code/other && rm win-only.md && ls' } as any)
  await clock.settle()
  expect(opens.slice(before).map(o => o.id)).toEqual([paneId(`win:${WIN_ROOT}`)])
  expect(opens.slice(before).some(o => o.focus)).toBe(false)
  expect(ran.slice(ranBefore).some(r => r[0] === 'git' && r.includes('status'))).toBe(true)
})

// One command naming two repos raises one tab: the one with more paths in it.
test('a command touching two repos brings only the one with more paths to the front', { options: { sessionTab: 'off' }, timeoutMs: 20_000 }, async ($, on) => {
  const opens: any[] = []
  const clock = world(on, [], opens)
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run(openCmd(WSL_ROOT))
  await $.command.run(openCmd(WIN_ROOT))
  await clock.settle()
  const before = opens.length
  await $.tool.call({ tool: 'Bash', command: 'touch C:/Users/user/Documents/Code/other/a.md //wsl.localhost/Ubuntu/home/user/my-repo/x.md //wsl.localhost/Ubuntu/home/user/my-repo/y.md' } as any)
  await clock.settle()
  expect(opens.slice(before).map(o => o.id)).toEqual([paneId('wsl:/home/user/my-repo')])
})


// A relative path with no cd lands in the session's folder: a session started in the repo sees its own rm.
test('a relative rm in the session folder brings that repo to the front and scans it', { options: { sessionTab: 'off' }, timeoutMs: 20_000 }, async ($, on) => {
  const opens: any[] = []
  const ran: string[][] = []
  const clock = world(on, ran, opens)
  git.cwd = WIN_ROOT
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as any)
  await $.session.start({ cwd: 'C:/Users/user/Documents/Code/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run(openCmd(WIN_ROOT))
  await $.command.run(openCmd(WSL_ROOT))
  await clock.settle()
  const before = opens.length
  const ranBefore = ran.length
  await $.tool.call({ tool: 'Bash', command: 'rm win-only.md' } as any)
  await clock.settle()
  git.cwd = 'C:/Users/user/Documents/Code/project'
  expect(opens.slice(before).map(o => o.id)).toEqual([paneId(`win:${WIN_ROOT}`)])
  expect(ran.slice(ranBefore).some(r => r[0] === 'git' && r.includes('status'))).toBe(true)
})


// Rodada 7, BUG 3: a prompt with no tool leaves the last turn empty; ▷ stays, grey and with nothing to press.
test('▷ stays grey with no press after a prompt with no tool, and ▷▷ still plays', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, read, ui } = await litWorld($, on)
  const drawn = async () => JSON.stringify(await ui.drawn())
  await $.prompt.submit({ text: 'primeiro' } as any)
  await command(clock, gate, read('wsl-only.md'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(10_000)
  expect(await drawn()).toContain('"replay-last"')
  await $.prompt.submit({ text: 'text only' } as any)
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(await drawn()).not.toContain('"replay-last"')
  expect(await drawn()).toContain('"▷"')
  expect(await drawn()).toContain('"replay-all"')
})

// 0.7.5: a file a command made and a later one removed is no longer in the tree when ▷▷ plays; the step that made
// it still draws its row (a plain one, out of clicks), and the step that removed it plays it out as a ghost.
test('▷▷ after a loop made files and an rm in a later prompt removed them shows them made, then gone', { options: LIVE_OPTIONS, timeoutMs: 60_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const batch = `${WSL_ROOT}/batch`
  const names = ['new-01.txt', 'new-02.txt', 'new-03.txt']
  try {
    const { clock, gate, ui } = await litWorld($, on)
    const drawn = async () => JSON.stringify(await ui.drawn())
    // Twice: the second time the files come back, the first rm is already behind them in the trail.
    for (const round of [1, 2]) {
      await $.prompt.submit({ text: `x${round}` } as any)
      const make = $.tool.call({ tool: 'Bash', command: `cd ${WSL_ROOT} && mkdir -p batch && for i in 01 02 03; do echo "file $i" > batch/new-$i.txt; done` } as any)
      await clock.advance(50)
      DIRS[WSL_ROOT] = [...root, ['batch', 'dir']]
      DIRS[batch] = names.map(name => [name, 'file'])
      gate.release()
      await make
      await $.classic.Stop({ stop_hook_active: false } as any)
      await clock.advance(20_000)
      await $.prompt.submit({ text: `y${round}` } as any)
      const drop = $.tool.call({ tool: 'Bash', command: `rm ${names.map(name => `${WSL_ROOT}/batch/${name}`).join(' ')}` } as any)
      await clock.advance(50)
      DIRS[batch] = []
      gate.release()
      await drop
      await $.classic.Stop({ stop_hook_active: false } as any)
      await clock.advance(20_000)
    }
    await ui.press({ key: 'replay-all' })
    // Per step of the replay: which files drew a plain row, and which a struck one.
    const made: Record<string, boolean[]> = {}
    const struck: Record<string, boolean[]> = {}
    let steps = ''
    for (let n = 0; n < 800 && (await drawn()).includes('■ '); n++) {
      steps = (await drawn()).match(/■ \d+\/\d+/)?.[0] ?? steps
      const rows = await specs(ui)
      made[steps] ??= names.map(() => false)
      struck[steps] ??= names.map(() => false)
      names.forEach((name, i) => {
        const row = rowOf(rows, name)
        if (!row) return
        if (nameSeg(row, name)?.s) struck[steps]![i] = true
        else made[steps]![i] = true
      })
      await clock.advance(TICK)
    }
    expect(steps).toBe('■ 4/4')
    for (const step of ['■ 1/4', '■ 3/4']) expect(made[step]).toEqual([true, true, true])
    for (const step of ['■ 2/4', '■ 4/4']) expect(struck[step]).toEqual([true, true, true])
  } finally {
    DIRS[WSL_ROOT] = root
    delete DIRS[batch]
  }
})

// 0.7.7: the replay of a loop that made files brings each one in as the bar reaches it, not all at the step's start.
test('▷ after a loop made files brings each row in on its own turn, in order', { options: LIVE_OPTIONS, timeoutMs: 60_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  const batch = `${WSL_ROOT}/batch`
  const names = ['new-01.txt', 'new-02.txt', 'new-03.txt']
  DIRS[WSL_ROOT] = [...root, ['batch', 'dir']]
  DIRS[batch] = [['old.txt', 'file']]
  try {
    const { clock, gate, read, ui } = await litWorld($, on)
    const drawn = async () => JSON.stringify(await ui.drawn())
    // An earlier prompt leaves batch open, as in the playground: the step has no folder to open on its way.
    await $.prompt.submit({ text: 'a' } as any)
    const look = read('batch\\old.txt')
    await clock.advance(50)
    gate.release()
    await look
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(20_000)
    await $.prompt.submit({ text: 'x' } as any)
    const make = $.tool.call({ tool: 'Bash', command: `cd ${WSL_ROOT} && for i in 01 02 03; do echo "file $i" > batch/new-$i.txt; done` } as any)
    await clock.advance(50)
    DIRS[batch] = [...names.map(name => [name, 'file']), ['old.txt', 'file']]
    gate.release()
    await make
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(20_000)
    await ui.press({ key: 'replay-last' })
    // The tick each row first shows in the replay.
    const first = names.map(() => -1)
    for (let n = 0; n < 800 && (await drawn()).includes('■ '); n++) {
      const rows = await specs(ui)
      names.forEach((name, i) => {
        if (first[i]! < 0 && rowOf(rows, name)) first[i] = n
      })
      await clock.advance(TICK)
    }
    expect(first.every(n => n >= 0)).toBe(true)
    // A whole light apart, not the tick a folder's rows take to come in.
    expect(first[1]! - first[0]!).toBeGreaterThan(10)
    expect(first[2]! - first[1]!).toBeGreaterThan(10)
  } finally {
    DIRS[WSL_ROOT] = root
    delete DIRS[batch]
  }
})

// Phase 9: a folder past `bigFolder` (200) opens folded around what matters, with `… N files` blocks.
const BIG = Array.from({ length: 1533 }, (_, i) => [`usp_${String(i).padStart(4, '0')}.sql`, 'file'] as [string, 'file'])
async function bigWorld($: any, on: any) {
  const w = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  await command(w.clock, w.gate, w.read('database\\usp_0766.sql'))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await w.clock.advance(10_000)
  return w
}
const dbId = `${WSL_ROOT}/database`
const foldId = (first: string) => `${dbId}\u0000${dbId}/${first}`
const names = (rows: any[]) => rows.map((r: any) => r.id.slice(r.id.lastIndexOf('/') + 1))

test('a read in a folder of 1533 files draws the file, 3 neighbours each side, two blocks and the total', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[dbId]!
  DIRS[dbId] = BIG
  try {
    const { ui } = await bigWorld($, on)
    const rows = await specs(ui)
    const under = rows.filter((r: any) => r.id.startsWith(`${dbId}/`) || r.id.startsWith(`${dbId}\u0000`))
    expect(names(under.filter((r: any) => !r.id.includes('\u0000')))).toEqual(['usp_0763.sql', 'usp_0764.sql', 'usp_0765.sql', 'usp_0766.sql', 'usp_0767.sql', 'usp_0768.sql', 'usp_0769.sql'])
    const blocks = under.filter((r: any) => r.id.includes('\u0000'))
    expect(blocks.map((r: any) => r.id)).toEqual([foldId('usp_0000.sql'), foldId('usp_0770.sql')])
    expect(JSON.stringify(blocks[0].left)).toContain('… 763 files')
    expect(JSON.stringify(rowOf(rows, 'database').left)).toContain('·1,533')
  } finally {
    DIRS[dbId] = db
  }
})

test('a click on a block unfolds that stretch and leaves the other block', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[dbId]!
  DIRS[dbId] = BIG
  try {
    const { clock, ui } = await bigWorld($, on)
    await ui.post({ press: foldId('usp_0000.sql') })
    await clock.settle()
    // The pane draws a window of rows: home and end look at each end of the folder.
    await ui.key({ key: 'home' })
    await clock.settle()
    let rows = await specs(ui)
    expect(rowOf(rows, 'usp_0000.sql')).not.toBe(undefined)
    expect(rows.some((r: any) => r.id.includes('\u0000'))).toBe(false)
    await ui.key({ key: 'end' })
    await clock.settle()
    rows = await specs(ui)
    expect(rowOf(rows, 'usp_0769.sql')).not.toBe(undefined)
    expect(rowOf(rows, 'usp_0771.sql')).toBe(undefined)
    expect(rows.filter((r: any) => r.id.includes('\u0000')).map((r: any) => r.id)).toEqual([foldId('usp_0770.sql')])
  } finally {
    DIRS[dbId] = db
  }
})

test('a click on the total shows the whole folder, and closing it folds it again', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[dbId]!
  DIRS[dbId] = BIG
  try {
    const { clock, ui } = await bigWorld($, on)
    await ui.post({ flat: dbId })
    await clock.settle()
    await ui.key({ key: 'end' })
    await clock.settle()
    let rows = await specs(ui)
    expect(rows.some((r: any) => r.id.includes('\u0000'))).toBe(false)
    expect(rowOf(rows, 'usp_1532.sql')).not.toBe(undefined)
    await ui.key({ key: 'home' })
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).toContain('·1,533')
    await ui.post({ press: dbId })
    await clock.settle()
    await clock.advance(1_000)
    await ui.post({ press: dbId })
    await clock.settle()
    rows = await specs(ui)
    expect(rows.filter((r: any) => r.id.includes('\u0000')).length).toBe(2)
    expect(rowOf(rows, 'usp_0000.sql')).toBe(undefined)
  } finally {
    DIRS[dbId] = db
  }
})

test('the ± filter shows the changed file of a big folder with no block', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[dbId]!
  DIRS[dbId] = BIG
  git.wslStatus = '## main...origin/main\0 M wsl-only.md\0 M database/usp_0100.sql\0'
  try {
    const { clock, ui } = await bigWorld($, on)
    expect(rowOf(await specs(ui), 'usp_0100.sql')).not.toBe(undefined)
    await ui.press({ key: 'changed' })
    await clock.settle()
    const rows = await specs(ui)
    expect(rowOf(rows, 'usp_0100.sql')).not.toBe(undefined)
    expect(rowOf(rows, 'usp_0097.sql')).toBe(undefined)
    expect(rows.some((r: any) => r.id.includes('\u0000'))).toBe(false)
  } finally {
    DIRS[dbId] = db
    git.wslStatus = WSL_STATUS
  }
})

test('the replay of a read in a big folder reveals the 7 rows and the blocks, not the 1533 files', { options: { sessionTab: 'off', replayAnimation: 'modern' }, timeoutMs: 30_000 }, async ($, on) => {
  const db = DIRS[dbId]!
  DIRS[dbId] = BIG
  try {
    const { clock, ui } = await bigWorld($, on)
    await ui.press({ key: 'collapse' })
    await ui.press({ key: 'replay-last' })
    // With 1533 reveals the bar would still be opening the folder here; folded, the step is on the file by now.
    await clock.advance(30 * TICK)
    const rows = await specs(ui)
    expect(rowOf(rows, 'usp_0763.sql')).not.toBe(undefined)
    expect(rowOf(rows, 'usp_0769.sql')).not.toBe(undefined)
    expect(rowOf(rows, 'usp_0000.sql')).toBe(undefined)
    expect(barOf(rows)).toBe(`${dbId}/usp_0766.sql`)
  } finally {
    DIRS[dbId] = db
  }
})

// The git activity chip rides on its own line under the branch row, which pulses in the action's tone while the action runs.
function nodesOf(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  const kids = Array.isArray(node) ? node : (node.children ?? [])
  return [...(Array.isArray(node) ? [] : [node]), ...kids.flatMap((kid: any) => nodesOf(kid))]
}
const branchRowOf = (drawn: any): any => nodesOf(drawn).find(n => n.type === 'Box' && n.props?.height === 1 && nodesOf(n).some(x => x.type === 'Text' && x.children?.[0] === 'main'))
const textOf = (node: any): string => (typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : (Array.isArray(node) ? node : (node.children ?? [])).map(textOf).join(''))
// The line under the branch row: a height 1 row without the head that draws the activity's label.
const chipRowOf = (drawn: any, label: string): any =>
  nodesOf(drawn).find(n => n.type === 'Box' && n.props?.height === 1 && !nodesOf(n).some(x => x.type === 'Text' && x.children?.[0] === 'main') && textOf(n).includes(label))
const branchColor = (drawn: any): string | undefined => nodesOf(drawn).find(n => n.type === 'Text' && n.children?.[0] === 'main')?.props?.color
const count = (text: string, needle: string) => text.split(needle).length - 1
const COMMIT = 'git -C /home/user/my-repo commit -m x'

test('a running git commit draws its chip on the branch row, not in the footer, and committed once it resolves', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = { result: { text: 'ok', isError: false, gitOperation: { commit: { sha: 'abc1234def' } } } }
  const call = $.tool.call({ tool: 'Bash', command: COMMIT } as any)
  await clock.settle()
  const drawn = await ui.drawn()
  expect(textOf(chipRowOf(drawn, 'committing…')).startsWith('  ')).toBe(true)
  expect(JSON.stringify(branchRowOf(drawn))).not.toContain('committing…')
  expect(JSON.stringify(branchRowOf(drawn))).toContain('origin/main')
  expect(count(JSON.stringify(drawn), 'committing…')).toBe(1)
  gate.release()
  await call
  await clock.settle()
  const after = await ui.drawn()
  expect(chipRowOf(after, 'committed')).not.toBe(undefined)
  expect(JSON.stringify(branchRowOf(after))).not.toContain('committed')
  expect(JSON.stringify(after)).not.toContain('committing…')
  expect(count(JSON.stringify(after), 'committed')).toBe(1)
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

test('the tree window gives the chip line one row while the chip shows', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  // Past the native scroll limit the pane keeps its own window, sized by bodyRows less the fixed rows.
  DIRS[WSL_ROOT] = [...root, ...Array.from({ length: 160 }, (_, i): [string, 'file'] => [`n${String(i).padStart(3, '0')}.md`, 'file'])]
  try {
    const { clock, gate, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 20 } })
    const before = (await specs(ui)).length
    await $.prompt.submit({ text: 'x' } as any)
    const call = $.tool.call({ tool: 'Bash', command: COMMIT } as any)
    await clock.settle()
    expect(chipRowOf(await ui.drawn(), 'committing…')).not.toBe(undefined)
    expect((await specs(ui)).length).toBe(before - 1)
    gate.release()
    await call
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.settle()
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('the branch name pulses 2 3 4 3 on the green ramp every 4 ticks while the commit runs, and stops when it resolves', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const green = RAMPS.green!
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = { result: { text: 'ok', isError: false, gitOperation: { commit: { sha: 'abc1234def' } } } }
  const call = $.tool.call({ tool: 'Bash', command: COMMIT } as any)
  await clock.settle()
  const seen: (string | undefined)[] = [branchColor(await ui.drawn())]
  for (let i = 0; i < 3; i++) {
    await clock.advance(4 * TICK)
    seen.push(branchColor(await ui.drawn()))
  }
  expect(seen).toEqual([green[2], green[3], green[4], green[3]])
  gate.release()
  await call
  await clock.settle()
  // The live step of the commit plays over the row and settles: past it, samples 4 ticks apart stay the same
  // (a pulse still on would change on every frame: 2 3 4 3 never repeats in two frames in a row).
  await clock.advance(60 * TICK)
  const still = branchColor(await ui.drawn())
  for (let i = 0; i < 3; i++) {
    await clock.advance(4 * TICK)
    expect(branchColor(await ui.drawn())).toBe(still)
  }
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

test('liveAnimation instant draws the running chip on the branch row without a pulse', { options: { ...LIVE_OPTIONS, liveAnimation: 'instant' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  const call = $.tool.call({ tool: 'Bash', command: COMMIT } as any)
  await clock.settle()
  const drawn = await ui.drawn()
  expect(chipRowOf(drawn, 'committing…')).not.toBe(undefined)
  expect(JSON.stringify(branchRowOf(drawn))).not.toContain('committing…')
  const first = branchColor(drawn)
  await clock.advance(8 * TICK)
  expect(branchColor(await ui.drawn())).toBe(first)
  gate.release()
  await call
  await clock.settle()
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

test('a failing push draws push failed in red on the line under the branch row', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.fail = true
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: 'git -C /home/user/my-repo push' } as any))
  await clock.settle()
  const drawn = await ui.drawn()
  expect(JSON.stringify(branchRowOf(drawn))).not.toContain('push failed')
  expect(JSON.stringify(branchRowOf(drawn))).toContain('origin/main')
  const row = chipRowOf(drawn, 'push failed')
  expect(textOf(row).startsWith('  ')).toBe(true)
  const label = nodesOf(row).find(n => n.type === 'Text' && n.children?.[0] === 'push failed')
  expect(label?.props?.color).toBe('#f87171')
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

// The git result rides on its step, so the replay draws it again under the branch while that step plays.
const SHA = { result: { text: 'ok', isError: false, gitOperation: { commit: { sha: 'abc1234def' } } } }
const chipLabel = (row: any, label: string): any => nodesOf(row).find(n => n.type === 'Text' && typeof n.children?.[0] === 'string' && n.children[0].startsWith(label))

test('a git add and commit record the commit result on the branch step', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const saved = trailSaved(on)
  const { clock, gate } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = SHA
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: 'git -C /home/user/my-repo add -A && git -C /home/user/my-repo commit -m x' } as any))
  await clock.settle()
  const step = saved.trail.find((one: any) => BRANCH_ROW in one.tones)
  // The last action of the chain, as the live chip keeps it.
  expect(step?.git).toEqual({ kind: 'git commit', label: 'committed', running: 'committing', state: 'done', detail: 'abc1234', tone: 'green', nerd: expect.any(String), plain: '●' })
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
})

// Plays the last interaction once the live chip is gone: each tick's drawing until the replay is over.
async function replayDrawn($: any, clock: any, ui: any): Promise<any[]> {
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.advance(50_000)
  expect(textOf(await ui.drawn())).not.toContain('committ')
  await ui.press({ key: 'replay-last' })
  await clock.advance(10)
  const out: any[] = []
  for (let i = 0; i < 80; i++) {
    const drawn = await ui.drawn()
    out.push(drawn)
    if (!JSON.stringify(drawn).includes('replay-stop')) break
    await clock.advance(TICK)
  }
  return out
}

test('▷ of a git commit draws committing… on the pulse under the branch while it lights, committed and its hash once it settles, and nothing after', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  const green = RAMPS.green!
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = SHA
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: COMMIT } as any))
  const frames = await replayDrawn($, clock, ui)
  const running = frames.filter(d => chipRowOf(d, 'committing…'))
  const done = frames.filter(d => chipRowOf(d, 'committed'))
  // Ramp up, hold and ramp down: the running form for every tick the branch is lighting, then the final one.
  expect(running.length).toBeGreaterThanOrEqual(TIMING.rampUp + TIMING.rampDown)
  expect(done.length).toBeGreaterThan(0)
  expect(frames.indexOf(done[0])).toBe(running.length)
  const bgs = running.map(d => chipLabel(chipRowOf(d, 'committing…'), 'committing…')?.props?.backgroundColor)
  expect(bgs.every(bg => [green[2], green[3], green[4]].includes(bg))).toBe(true)
  expect(new Set(bgs).size).toBeGreaterThan(1)
  expect(running.some(d => green.includes(branchColor(d)!))).toBe(true)
  for (const d of running) expect(JSON.stringify(branchRowOf(d))).not.toContain('committing…')
  const row = chipRowOf(done[0], 'committed')
  expect(textOf(row).startsWith('  ')).toBe(true)
  expect(textOf(row)).toContain('abc1234')
  expect(textOf(done[0])).not.toContain('committing…')
  const label = chipLabel(row, 'committed')
  expect(label?.props?.color).toBe(TONES.green!.solid)
  expect(label?.props?.backgroundColor).toBe(undefined)
  const last = frames[frames.length - 1]
  expect(JSON.stringify(last)).not.toContain('replay-stop')
  expect(textOf(last)).not.toContain('committ')
})

test('the tree window gives the replayed chip line one row while it shows, and ■ takes it away', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const root = DIRS[WSL_ROOT]!
  DIRS[WSL_ROOT] = [...root, ...Array.from({ length: 160 }, (_, i): [string, 'file'] => [`n${String(i).padStart(3, '0')}.md`, 'file'])]
  try {
    const { clock, gate, ui } = await litWorld($, on, { ...props, scroll: { offset: 0, bodyRows: 20 } })
    await $.prompt.submit({ text: 'x' } as any)
    gate.result = SHA
    await command(clock, gate, $.tool.call({ tool: 'Bash', command: COMMIT } as any))
    await $.classic.Stop({ stop_hook_active: false } as any)
    await clock.advance(50_000)
    const before = (await specs(ui)).length
    await ui.press({ key: 'replay-last' })
    await clock.advance(10)
    expect(chipRowOf(await ui.drawn(), 'committing…')).not.toBe(undefined)
    expect((await specs(ui)).length).toBe(before - 1)
    await ui.press({ key: 'replay-stop' })
    await clock.advance(10)
    expect(textOf(await ui.drawn())).not.toContain('committ')
  } finally {
    DIRS[WSL_ROOT] = root
  }
})

test('▷ of a failed push draws pushing… and then push failed in red under the branch', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.fail = true
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: 'git -C /home/user/my-repo push' } as any))
  gate.fail = false
  const frames = await replayDrawn($, clock, ui)
  expect(frames.some(d => chipRowOf(d, 'pushing…'))).toBe(true)
  const failed = frames.find(d => chipRowOf(d, 'push failed'))
  expect(failed).not.toBe(undefined)
  expect(chipLabel(chipRowOf(failed, 'push failed'), 'push failed')?.props?.color).toBe('#f87171')
  expect(textOf(frames[frames.length - 1])).not.toContain('push failed')
})

test('a branch step from an older trail, with no git result, replays lit with no chip line', { options: LIVE_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  // A reload: the tab's registry and its trail come back from $.state. The trail is stored as 0.3 saved it, with no
  // git result, and the registry keeps the tab its close took out.
  const id = paneId('wsl:/home/user/my-repo')
  const kept = { trail: [] as any[], registry: null as any }
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'trail' && e.key === 'trail') {
      kept.trail = e.value.map(({ git: _, ...rest }: any) => rest)
      return next({ ...e, value: kept.trail })
    }
    if (e.plugin === 'trail' && e.key === 'repos') {
      if (e.value?.[id]) kept.registry = e.value
      else if (kept.registry) return next({ ...e, value: { ...e.value, [id]: kept.registry[id] } })
    }
    return next(e)
  })
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = SHA
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: COMMIT } as any))
  await $.classic.Stop({ stop_hook_active: false } as any)
  await clock.settle()
  expect(kept.trail.some((one: any) => BRANCH_ROW in one.tones)).toBe(true)
  await ui.unmount()
  await $.command.run({ ...openCmd(''), args: `close ${WSL_ROOT}` })
  await clock.settle()
  const back = await $.ui.mount({ plugin: 'trail', surface: 'desktop', component: 'Pane', requestId: id, props })
  await clock.settle()
  const frames = await replayDrawn($, clock, back)
  expect(frames.length).toBeGreaterThan(TIMING.rampUp)
  expect(frames.some(d => RAMPS.green!.includes(branchColor(d)!))).toBe(true)
  for (const d of frames) expect(textOf(d)).not.toContain('committ')
})

test('classic replays the branch step with no chip line', { options: { sessionTab: 'off', replayAnimation: 'classic' }, timeoutMs: 30_000 }, async ($, on) => {
  const { clock, gate, ui } = await litWorld($, on)
  await $.prompt.submit({ text: 'x' } as any)
  gate.result = SHA
  await command(clock, gate, $.tool.call({ tool: 'Bash', command: COMMIT } as any))
  const frames = await replayDrawn($, clock, ui)
  expect(JSON.stringify(frames[0])).toContain('■ 1/1')
  for (const d of frames) expect(textOf(d)).not.toContain('committ')
})
