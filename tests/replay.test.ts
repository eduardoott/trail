import { expect, test } from 'claude-code/testing'
import { BRANCH_ROW, CATCH, kindOf, LIVE, lineDelta, namesOf, plan, rampOf, record, route, RUSH, splitStep, stepsFor, ticksOf, TIMING, type Step } from '../hooks/replay'

const step = (epoch: number, turn: number, tones: Record<string, string>): Step => ({ epoch, turn, tones })

test('lights of one command merge into one step, a new command opens the next', () => {
  let trail: Step[] = []
  trail = record(trail, step(1, 1, { a: 'purple' }))
  trail = record(trail, step(1, 1, { b: 'orange', a: 'orange' }))
  trail = record(trail, step(2, 1, { c: 'green' }))
  expect(trail).toEqual([step(1, 1, { a: 'orange', b: 'orange' }), step(2, 1, { c: 'green' })])
})

test('a late light joins its own command, in order, and the trail keeps only the newest steps', () => {
  let trail = [step(1, 1, { a: 'purple' }), step(3, 1, { c: 'purple' })]
  trail = record(trail, step(2, 1, { b: 'green' }))
  expect(trail.map(one => one.epoch)).toEqual([1, 2, 3])
  trail = record(trail, step(4, 1, { d: 'orange' }), 3)
  expect(trail.map(one => one.epoch)).toEqual([2, 3, 4])
})

test('the last interaction is the steps since the last prompt, the session is all of them', () => {
  const trail = [step(1, 1, { a: 'purple' }), step(2, 2, { b: 'orange' }), step(3, 2, { c: 'green' })]
  expect(stepsFor(trail, 'last', 2).map(one => one.epoch)).toEqual([2, 3])
  expect(stepsFor(trail, 'all', 2).map(one => one.epoch)).toEqual([1, 2, 3])
  expect(stepsFor(trail, 'last', 3)).toEqual([])
})

test('record merges files field by field, later completing earlier', () => {
  let trail = record([], { epoch: 1, turn: 1, tones: { a: 'orange' }, files: { a: { removed: 2, added: 1 } } })
  trail = record(trail, { epoch: 1, turn: 1, tones: { a: 'orange' }, files: { a: { born: true } } })
  expect(trail[0]!.files).toEqual({ a: { removed: 2, added: 1, born: true } })
})
test('lineDelta counts lines', () => {
  expect(lineDelta('a\nb', 'a\nb\nc\nd')).toEqual([2, 0])
  expect(lineDelta('a\nb\nc', 'a')).toEqual([0, 2])
  expect(lineDelta('', 'a')).toEqual([1, 0])
})
test('route walks one row per tick and brakes two ticks on each end', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const f = route(rows, 'a', 'g', [], {})
  expect(f.map(x => x.kind === 'bar' ? x.ticks : x.kind)).toEqual([2, 2, 1, 1, 2, 2])
  expect(f.map(x => x.kind === 'bar' && x.row)).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
})
test('route stops on a closed folder, opens it and reveals its children one per tick', () => {
  const f = route(['r', 'x', 'y'], 'r', 'x/b', ['x'], { x: ['x/a', 'x/b'] })
  expect(f.map(x => x.kind)).toEqual(['bar', 'open', 'reveal', 'reveal', 'bar', 'bar'])
})
test('a long route walks more rows per tick so the step fits the cap', () => {
  const rows = Array.from({ length: 90 }, (_, i) => `f${i}`)
  const f = route(rows, 'f0', 'f89', [], {})
  expect(ticksOf(f)).toBeLessThanOrEqual(Math.floor((TIMING.cap / TIMING.tick) / 2))
})
test('plan of an Edit is navigate, 5 shades up, 12 icon frames, hold, 4 shades down, settle, between', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a.ts': 'orange' }, files: { '/r/a.ts': { added: 3, removed: 1 } } }
  const f = plan(step, ['/r/a.ts'], '/r/a.ts', {})
  const kinds = f.map(x => x.kind)
  expect(kinds.filter(k => k === 'shade').length).toBe(9)
  expect(kinds.filter(k => k === 'icon').length).toBe(12)
  expect(f.find(x => x.kind === 'icon' && x.frame === 8)).toMatchObject({ count: 1 })
  expect(ticksOf(f)).toBe(5 + 12 + 6 + 4 + 4)
})
test('ticksOf a 1x plan of a Read two folders deep stays under the cap', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a/b/f.ts': 'purple' } }
  const f = plan(step, ['/r/a'], null, { '/r/a': ['/r/a/b'], '/r/a/b': ['/r/a/b/f.ts'] })
  expect(ticksOf(f) * TIMING.tick).toBeLessThanOrEqual(TIMING.cap)
})

test('kindOf and rampOf name each kind of step', () => {
  const s = (tone: string, file?: object): Step => ({ epoch: 1, turn: 1, tones: { f: tone }, files: file ? { f: file } : undefined })
  const cases: [Step, string, string][] = [
    [s('orange', { born: true, added: 2 }), 'born', 'green'],
    [s('orange', { gone: true }), 'gone', 'red'],
    [s('purple'), 'read', 'purple'],
    [s('orange', { added: 1 }), 'edit', 'orange'],
    [s('orange', { removed: 0 }), 'edit', 'orange'],
    [s('orange'), 'shell', 'teal'],
    [s('teal'), 'shell', 'teal'],
    [s('green'), 'shell', 'green'],
  ]
  for (const [step, kind, ramp] of cases) {
    expect(kindOf(step, 'f')).toBe(kind)
    expect(rampOf(step, 'f')).toBe(ramp)
  }
})
test('two files in one step play in sequence, with one between at the end', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { a: 'orange', c: 'teal' } }
  const f = plan(step, ['a', 'b', 'c'], 'a', {})
  const settles = f.flatMap((x, i) => (x.kind === 'settle' ? [i] : []))
  expect(settles.length).toBe(2)
  const bars = f.flatMap((x, i) => (x.kind === 'bar' ? [i] : []))
  expect(bars.every(i => i > settles[0]! && i < settles[1]!)).toBe(true)
  expect(f.filter(x => x.kind === 'wait').map(x => x.kind === 'wait' && x.ticks)).toEqual([6, 6, 4])
  expect(f[f.length - 1]).toEqual({ kind: 'wait', ticks: TIMING.between })
})
test('a gone file leaves the rows and the next route starts from the row now at its index', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { b: 'orange', d: 'orange' }, files: { b: { gone: true }, d: { added: 1 } } }
  const f = plan(step, ['a', 'b', 'c', 'd'], 'b', {})
  const after = f.slice(f.findIndex(x => x.kind === 'settle') + 1)
  expect(after.filter(x => x.kind === 'bar').map(x => x.kind === 'bar' && x.row)).toEqual(['d'])
})
test('a closed folder opens once for two files under it', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a/x': 'purple', '/r/a/y': 'purple' } }
  const f = plan(step, ['/r/a', '/r/z'], '/r/z', { '/r/a': ['/r/a/x', '/r/a/y'] })
  expect(f.filter(x => x.kind === 'open').length).toBe(1)
  expect(f.filter(x => x.kind === 'reveal').length).toBe(2)
  expect(f.filter(x => x.kind === 'settle').length).toBe(2)
})
test('a step with only the branch row lights it without route or icon', () => {
  const f = plan({ epoch: 1, turn: 1, tones: { '#branch': 'green' } }, ['a'], 'a', {})
  expect(f.map(x => (x.kind === 'shade' ? x.shade : x.kind === 'wait' ? `w${x.ticks}` : x.kind))).toEqual([1, 2, 3, 4, 5, 'w6', 4, 3, 2, 1, 'settle', 'w4'])
  expect(f.every(x => !('file' in x) || x.file === '#branch')).toBe(true)
})
test('a file not in the rows nor behind a closed folder is skipped', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { gone: 'orange', b: 'purple' } }
  const f = plan(step, ['a', 'b'], 'a', {})
  expect(f.some(x => 'file' in x && x.file === 'gone')).toBe(false)
  expect(f.filter(x => x.kind === 'settle').length).toBe(1)
  expect(plan({ epoch: 1, turn: 1, tones: { nope: 'purple' } }, ['a'], 'a', {})).toEqual([])
})
test('plan raises rows per tick on the routes until the step fits the cap', () => {
  const rows = Array.from({ length: 600 }, (_, i) => `f${i}`)
  const step: Step = { epoch: 1, turn: 1, tones: { f599: 'purple', f0: 'purple', f598: 'purple' } }
  const f = plan(step, rows, 'f0', {})
  expect(ticksOf(f) * TIMING.tick).toBeLessThanOrEqual(TIMING.cap)
  expect(f.filter(x => x.kind === 'icon').length).toBe(36)
  expect(f.filter(x => x.kind === 'bar' && x.ticks === TIMING.brake).length).toBe(12)
})

test('a LIVE plan of a Read one folder deep stays near a second', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a/f.ts': 'purple' } }
  const f = plan(step, ['/r/a'], null, { '/r/a': ['/r/a/f.ts'] }, LIVE)
  expect(f.some(x => x.kind === 'wait')).toBe(false)
  expect(ticksOf(f) * TIMING.tick).toBeLessThanOrEqual(LIVE.cap)
})
test('a CATCH plan jumps the bar and opens folders without reveal', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a/b/f.ts': 'orange' }, files: { '/r/a/b/f.ts': { added: 2 } } }
  const f = plan(step, ['/r/a'], '/r/x', { '/r/a': ['/r/a/b'], '/r/a/b': ['/r/a/b/f.ts'] }, CATCH, true)
  expect(f.filter(x => x.kind === 'bar').length).toBe(1)
  expect(f.some(x => x.kind === 'reveal')).toBe(false)
  expect(ticksOf(f) * TIMING.tick).toBeLessThanOrEqual(CATCH.cap)
})
test('a RUSH plan of one file a folder deep jumps and takes 250 ms at most, faster than CATCH', () => {
  const step: Step = { epoch: 1, turn: 1, tones: { '/r/a/f.ts': 'orange' }, files: { '/r/a/f.ts': { added: 2 } } }
  const kids = { '/r/a': ['/r/a/f.ts'] }
  const rush = plan(step, ['/r/a'], '/r/x', kids, RUSH, true)
  const ms = ticksOf(rush) * TIMING.tick
  expect(ms).toBeGreaterThanOrEqual(150)
  expect(ms).toBeLessThanOrEqual(RUSH.cap)
  expect(ms).toBeLessThan(ticksOf(plan(step, ['/r/a'], '/r/x', kids, CATCH, true)) * TIMING.tick)
  expect(rush.filter(x => x.kind === 'icon').length).toBe(RUSH.iconTicks)
})
test('splitStep gives one file a step in order, each with its own files entry and the branch on the first', () => {
  const step: Step = { epoch: 3, turn: 2, tones: { [BRANCH_ROW]: 'teal', '/r/a.ts': 'purple', '/r/b.ts': 'orange', '/r/c.ts': 'red' }, files: { '/r/b.ts': { added: 1 }, '/r/c.ts': { gone: true } } }
  expect(splitStep(step)).toEqual([
    { epoch: 3, turn: 2, tones: { '/r/a.ts': 'purple', [BRANCH_ROW]: 'teal' } },
    { epoch: 3, turn: 2, tones: { '/r/b.ts': 'orange' }, files: { '/r/b.ts': { added: 1 } } },
    { epoch: 3, turn: 2, tones: { '/r/c.ts': 'red' }, files: { '/r/c.ts': { gone: true } } },
  ])
  const one: Step = { epoch: 1, turn: 1, tones: { '/r/a.ts': 'purple' } }
  expect(splitStep(one)).toEqual([one])
})
test('namesOf a file tool is the tool itself', () => {
  expect(namesOf('Read', '')).toEqual(['Read'])
  expect(namesOf('Edit', '')).toEqual(['Edit'])
  expect(namesOf('Write', '')).toEqual(['Write'])
  expect(namesOf('NotebookEdit', '')).toEqual(['NotebookEdit'])
})
test('namesOf a shell command is the first word of each segment, quotes and escapes kept whole', () => {
  expect(namesOf('Bash', "sed -i 's/blue/green/' test-screen/shell.txt")).toEqual(['sed'])
  expect(namesOf('Bash', 'cd "/c/projects/example" && grep -n "function walk\\|export type Node" src/tree.ts | head -20')).toEqual(['cd', 'grep', 'head'])
  expect(namesOf('Bash', 'rm test-screen/delete.txt')).toEqual(['rm'])
  expect(namesOf('Bash', 'FOO=1 sudo /usr/bin/grep -r a .; echo "x | y"')).toEqual(['grep', 'echo'])
  expect(namesOf('Bash', "echo 'a && b' || ls\nwc -l")).toEqual(['echo', 'ls', 'wc'])
  expect(namesOf('PowerShell', 'C:\\x\\py.exe -I run.py; Get-ChildItem | Select-Object -First 3')).toEqual(['py.exe', 'Get-ChildItem', 'Select-Object'])
  expect(namesOf('Bash', '$HOME/bin/x; "quoted" a; ; ')).toEqual([])
})
test('namesOf gives git its verb as one label, past the options', () => {
  expect(namesOf('Bash', 'git add -A && git commit -m "trail 0.1.0: x"')).toEqual(['git add', 'git commit'])
  expect(namesOf('Bash', 'git push origin main')).toEqual(['git push'])
  expect(namesOf('Bash', 'git checkout -b x')).toEqual(['git checkout'])
  expect(namesOf('Bash', 'git merge --no-ff x')).toEqual(['git merge'])
  expect(namesOf('Bash', 'git stash push -m "wip"')).toEqual(['git stash'])
  expect(namesOf('Bash', 'git revert HEAD --no-edit')).toEqual(['git revert'])
  expect(namesOf('Bash', 'git pull --rebase')).toEqual(['git pull'])
  expect(namesOf('Bash', 'git -C x status')).toEqual(['git status'])
  expect(namesOf('Bash', 'git --git-dir=.git -c core.autocrlf=true log --oneline')).toEqual(['git log'])
  expect(namesOf('Bash', 'git')).toEqual(['git'])
})
// Decision: a subshell or group loses its brackets (a lone one is skipped), its commands count like the rest.
test('namesOf keeps the commands of a subshell, without the brackets', () => {
  expect(namesOf('Bash', '(cd x && make) || true')).toEqual(['cd', 'make', 'true'])
  expect(namesOf('Bash', '{ a; b; }')).toEqual(['a', 'b'])
})
test('namesOf cuts a long label at 24 characters with an ellipsis', () => {
  const long = 'a'.repeat(30)
  expect(namesOf('Bash', `${long} x`)).toEqual(['a'.repeat(23) + '…'])
  expect(namesOf('Bash', 'git ' + 'b'.repeat(30))).toEqual(['git ' + 'b'.repeat(19) + '…'])
  expect(namesOf('Bash', 'c'.repeat(24))).toEqual(['c'.repeat(24)])
})
test('record merges the names of one epoch in order without repeats, splitStep copies them to each piece', () => {
  let trail = record([], { epoch: 1, turn: 1, tones: { a: 'orange' }, names: ['cd', 'sed'] })
  trail = record(trail, { epoch: 1, turn: 1, tones: { b: 'orange' }, names: ['sed', 'git commit'] })
  trail = record(trail, { epoch: 1, turn: 1, tones: { c: 'purple' } })
  expect(trail[0]!.names).toEqual(['cd', 'sed', 'git commit'])
  trail = record(trail, { epoch: 2, turn: 1, tones: { d: 'purple' }, names: ['Read'] })
  expect(trail.map(one => one.names)).toEqual([['cd', 'sed', 'git commit'], ['Read']])
  const plain = record([], { epoch: 3, turn: 1, tones: { e: 'purple' } })
  expect('names' in plain[0]!).toBe(false)
  const step: Step = { epoch: 4, turn: 2, tones: { [BRANCH_ROW]: 'green', '/r/a.ts': 'orange', '/r/b.ts': 'orange' }, names: ['git add', 'git commit'] }
  expect(splitStep(step).map(one => one.names)).toEqual([['git add', 'git commit'], ['git add', 'git commit']])
})

// 13.2, 24/10: the lines of a here-document are input, and a script's words are no commands.
test('namesOf skips a here-document body and words that are no program name', () => {
  const py = `cd "/c/x" && py - <<'PY'\np='a.md'; s=open(p,encoding='utf-8').read()\ns=s.replace('a','b'); print('ok')\nPY\necho fim`
  expect(namesOf('Bash', py)).toEqual(['cd', 'py', 'echo'])
  expect(namesOf('Bash', 'cat <<EOF > out.txt\nopen(p); x=1\nEOF')).toEqual(['cat'])
  expect(namesOf('Bash', 'cat <<-"END"\n\tjunk; more\n\tEND\nls')).toEqual(['cat', 'ls'])
  expect(namesOf('Bash', "open(p,'w').write(s); print('ok'); s[k:]")).toEqual([])
  expect(namesOf('Bash', 'git -C x "commit"')).toEqual(['git'])
  // `<<<` is a here-string, not a here-document: nothing is skipped.
  expect(namesOf('Bash', 'tr a b <<< abc; ls')).toEqual(['tr', 'ls'])
})

// Phase 9: reveals count against the cap like the bar's moves do, so a huge folder opens within it.
test('opening a folder of 1533 children stays within the cap, in the replay and live', () => {
  const dir = '/r/db'
  const kids = Array.from({ length: 1533 }, (_, i) => `${dir}/p${i}`)
  const step: Step = { epoch: 1, turn: 1, tones: { [kids[766]!]: 'purple' } }
  for (const timing of [TIMING, LIVE]) {
    const f = plan(step, ['/r', dir], null, { [dir]: kids }, timing)
    expect(ticksOf(f)).toBeLessThanOrEqual(timing.cap / TIMING.tick)
    expect(f.filter(x => x.kind === 'reveal').flatMap(x => ('ids' in x ? x.ids : [x.id])).length).toBe(1533)
  }
})
test('a folder of 20 children still reveals one child per tick', () => {
  const dir = '/r/db'
  const kids = Array.from({ length: 20 }, (_, i) => `${dir}/p${i}`)
  const f = plan({ epoch: 1, turn: 1, tones: { [kids[10]!]: 'purple' } }, ['/r', dir], null, { [dir]: kids })
  expect(f.filter(x => x.kind === 'reveal').length).toBe(20)
})
