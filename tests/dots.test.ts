import { expect, test } from 'claude-code/testing'
import { RAMPS } from '../hooks/git'
import { DOT, dotSegs, folders, histories, history } from '../hooks/dots'
import { BRANCH_ROW, type Step, type StepFile } from '../hooks/replay'

const step = (epoch: number, turn: number, tones: Record<string, string>, files?: Record<string, StepFile>, names?: string[]): Step => ({ epoch, turn, tones, ...(files ? { files } : {}), ...(names ? { names } : {}) })
const tone = (ramp: string) => RAMPS[ramp]![3]

test('history lists what each command did to the file, oldest first', () => {
  const trail = [step(1, 1, { a: 'purple' }), step(2, 1, { a: 'orange', b: 'purple' }, { a: { added: 1, removed: 0 } }), step(3, 2, { a: 'purple' })]
  expect(history(trail, 'a')).toEqual(['read', 'edit', 'read'])
  expect(history(trail, 'b')).toEqual(['read'])
  expect(history(trail, 'c')).toEqual([])
})

test('the same thing done again inside one answer is one dot, done again in the next answer is another', () => {
  const trail = [step(1, 1, { a: 'purple' }), step(2, 1, { a: 'purple' }), step(3, 1, { a: 'purple' }), step(4, 2, { a: 'purple' })]
  expect(history(trail, 'a')).toEqual(['read', 'read'])
})

test('a read between two edits keeps every dot', () => {
  const edit: StepFile = { added: 1, removed: 1 }
  const trail = [step(1, 1, { a: 'orange' }, { a: edit }), step(2, 1, { a: 'purple' }), step(3, 1, { a: 'orange' }, { a: edit })]
  expect(history(trail, 'a')).toEqual(['edit', 'read', 'edit'])
})

test('born, gone and a shell write without counts are their own kinds', () => {
  const trail = [step(1, 1, { a: 'orange' }, { a: { born: true } }), step(2, 2, { a: 'orange' }), step(3, 3, { a: 'orange' }, { a: { gone: true } })]
  expect(history(trail, 'a')).toEqual(['born', 'shell', 'gone'])
})

test('a commit is its own green dot, even after a shell write in the same answer', () => {
  const trail = [step(1, 1, { a: 'purple' }), step(2, 1, { a: 'orange' }), step(3, 1, { a: 'green' }, undefined, ['git commit'])]
  expect(history(trail, 'a')).toEqual(['read', 'shell', 'commit'])
  expect(dotSegs(['commit'], 8, 'time')).toEqual([{ t: DOT, c: tone('green') }])
})

test('a staged file is a shell dot, the commit dot waits for git commit', () => {
  expect(history([step(1, 1, { a: 'green' }, undefined, ['git add'])], 'a')).toEqual(['shell'])
  expect(history([step(1, 1, { a: 'green' }, undefined, ['git add']), step(2, 2, { a: 'green' }, undefined, ['git commit'])], 'a')).toEqual(['shell', 'commit'])
  expect(history([step(1, 1, { a: 'green' }, undefined, ['git add', 'git commit'])], 'a')).toEqual(['commit'])
})

test('a file rewritten by a merge, rebase or cherry-pick is a shell dot, not a read', () => {
  for (const name of ['git merge', 'git rebase', 'git cherry-pick']) expect(history([step(1, 1, { a: 'purple' }, undefined, [name])], 'a')).toEqual(['shell'])
  expect(history([step(1, 1, { a: 'purple' }, undefined, ['Read'])], 'a')).toEqual(['read'])
})

test('histories gives every file of a mixed trail what history gives it, in one pass', () => {
  const edit: StepFile = { added: 1, removed: 0 }
  const trail = [
    step(1, 1, { a: 'purple', b: 'purple', [BRANCH_ROW]: 'teal' }),
    step(2, 1, { a: 'orange', c: 'orange' }, { a: edit, c: { born: true } }),
    step(3, 1, { a: 'purple', b: 'purple' }),
    step(4, 2, { a: 'purple', d: 'green' }, undefined, ['git commit']),
    step(5, 2, { b: 'orange', c: 'orange' }, { c: { gone: true } }),
    step(6, 3, { d: 'purple' }, undefined, ['git merge']),
  ]
  const all = histories(trail)
  const files = ['a', 'b', 'c', 'd', BRANCH_ROW]
  expect([...all.keys()].sort()).toEqual([...files].sort())
  for (const f of files) expect(all.get(f)).toEqual(history(trail, f))
  expect(all.get('a')).toEqual(['read', 'edit', 'read', 'read'])
  expect(histories([]).size).toBe(0)
})

test('folders sums the files under each ancestor up to the root, the branch row left out', () => {
  const root = '/r'
  const all = histories([step(1, 1, { '/r/x/a': 'purple', '/r/x/y/b': 'orange', '/r/c': 'orange', [BRANCH_ROW]: 'teal' }, { '/r/x/y/b': { added: 1, removed: 0 } })])
  const sums = folders(all, root)
  expect(sums.get('/r/x')).toEqual(['read', 'edit'])
  expect(sums.get('/r/x/y')).toEqual(['edit'])
  // The root has no row to carry a sum.
  expect(sums.has(root)).toBe(false)
  expect(sums.has('/')).toBe(false)
})

// 500 steps of 3 files each over 150 paths in 20 folders: the map and 60 folder sums in one pass, never a walk of the
// trail per row (that cost 50 ms a frame at 1x).
test('the map of every history and the folder sums of a full trail come under 20 ms', () => {
  const root = '/r'
  const paths = Array.from({ length: 150 }, (_, i) => `${root}/d${i % 20}/f${i}.ts`)
  const trail = Array.from({ length: 500 }, (_, i) => step(i + 1, Math.floor(i / 5) + 1, Object.fromEntries([0, 1, 2].map(k => [paths[(i * 3 + k) % 150]!, k === 1 ? 'orange' : 'purple']))))
  const t0 = performance.now()
  const all = histories(trail)
  const sums = folders(all, root)
  let n = 0
  for (let i = 0; i < 60; i++) n += (sums.get(`${root}/d${i % 20}`) ?? []).length
  const ms = performance.now() - t0
  expect(all.size).toBe(150)
  expect(n).toBeGreaterThan(0)
  expect(ms).toBeLessThan(20)
})

test('time order draws the oldest dot on the right, each dot in its tone, glued together', () => {
  expect(dotSegs(['read', 'edit'], 8, 'time')).toEqual([
    { t: DOT, c: tone('orange') },
    { t: DOT, c: tone('purple') },
  ])
  expect(dotSegs([], 8, 'time')).toEqual([])
})

test('kind order groups reads on the right, then edits, then born, gone and shell', () => {
  const segs = dotSegs(['born', 'read', 'edit', 'read', 'shell', 'gone'], 8, 'kind')
  expect(segs.map(s => s.c)).toEqual([tone('teal'), tone('red'), tone('green'), tone('orange'), tone('purple'), tone('purple')])
})

test('past the limit the row goes compact: one dot a kind with its count, in kind order', () => {
  const kinds = [...Array(9).fill('read'), 'edit'] as const
  expect(dotSegs([...kinds], 8, 'time')).toEqual([
    { t: DOT, c: tone('orange') },
    { t: ` ${DOT}`, c: tone('purple') }, { t: '9', c: RAMPS.purple![1] },
  ])
})

test('exactly the limit stays single dots, one past it goes compact', () => {
  expect(dotSegs(Array(8).fill('read'), 8, 'time')).toEqual(Array(8).fill({ t: DOT, c: tone('purple') }))
  expect(dotSegs(Array(9).fill('read'), 8, 'time')).toEqual([{ t: DOT, c: tone('purple') }, { t: '9', c: RAMPS.purple![1] }])
})

test('compact always groups and off draws nothing', () => {
  expect(dotSegs(['read', 'read', 'edit'], 'compact', 'time')).toEqual([
    { t: DOT, c: tone('orange') },
    { t: ` ${DOT}`, c: tone('purple') }, { t: '2', c: RAMPS.purple![1] },
  ])
  expect(dotSegs(['read', 'read', 'edit'], 'off', 'time')).toEqual([])
})
