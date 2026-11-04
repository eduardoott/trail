import { expect, test } from 'claude-code/testing'
import type { FileTree } from '../types'
import { emptyTree, toNodes, visibleRows } from '../hooks/tree'

// Phase 9: a folder past `limit` children opens folded, showing only what matters and `… N files` blocks between.
const ROOT = 'C:/repo'
const DIR = `${ROOT}/database/40-procedure`
const name = (i: number) => `usp_${String(i).padStart(4, '0')}.sql`
const file = (i: number) => `${DIR}/${name(i)}`
const entry = (n: string, kind: 'file' | 'dir' = 'file') => ({ name: n, kind, mtimeMs: 1, size: 1, isLink: false })

function bigTree(count = 1533, extra: ReturnType<typeof entry>[] = [], over: Partial<FileTree> = {}): FileTree {
  const kids = toNodes(DIR, [...Array.from({ length: count }, (_, i) => entry(name(i))), ...extra])
  return {
    ...emptyTree(ROOT),
    nodes: [...toNodes(ROOT, [entry('database', 'dir')]).map(n => ({ ...n, loaded: true })), ...toNodes(`${ROOT}/database`, [entry('40-procedure', 'dir')]).map(n => ({ ...n, loaded: true })), ...kids],
    expanded: [`${ROOT}/database`, DIR],
    ...over,
  }
}

const under = (t: FileTree, ctx?: { touched: Set<string>; limit: number }) => visibleRows(t, ctx).filter(r => r.node.parent === DIR)
const files = (rows: ReturnType<typeof visibleRows>) => rows.filter(r => r.node.kind === 'file').map(r => r.node.name)
const folds = (rows: ReturnType<typeof visibleRows>) => rows.filter(r => r.node.kind === 'fold').map(r => r.count)

test('a folder of 1533 files with one touched shows it, 3 neighbours each side and two blocks', () => {
  const rows = under(bigTree(), { touched: new Set([file(766)]), limit: 200 })
  expect(files(rows)).toEqual([763, 764, 765, 766, 767, 768, 769].map(name))
  expect(folds(rows)).toEqual([763, 763])
  expect(rows.map(r => r.node.kind)).toEqual(['fold', 'file', 'file', 'file', 'file', 'file', 'file', 'file', 'fold'])
  expect(rows[0]!.depth).toBe(2)
})

test('two touched files 4 apart leave no block between them', () => {
  const rows = under(bigTree(), { touched: new Set([file(100), file(104)]), limit: 200 })
  expect(files(rows)).toEqual([97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107].map(name))
  expect(folds(rows)).toEqual([97, 1425])
})

test('a git-changed file and a subfolder stay in a folded folder', () => {
  const t = bigTree(1533, [entry('sub', 'dir')], { git: { [file(1000)]: 'M' } })
  const rows = under(t, { touched: new Set(), limit: 200 })
  expect(files(rows)).toEqual([997, 998, 999, 1000, 1001, 1002, 1003].map(name))
  expect(rows.filter(r => r.node.kind === 'dir').map(r => r.node.name)).toEqual(['sub'])
  expect(folds(rows)).toEqual([997, 529])
})

test('limit 0 turns the fold off and a folder within the limit never folds', () => {
  expect(under(bigTree(), { touched: new Set([file(766)]), limit: 0 }).length).toBe(1533)
  expect(under(bigTree(200), { touched: new Set([file(100)]), limit: 200 }).length).toBe(200)
  expect(under(bigTree(201), { touched: new Set([file(100)]), limit: 200 }).some(r => r.node.kind === 'fold')).toBe(true)
})

test('a query shows every match, with no block', () => {
  const rows = under(bigTree(1533, [], { query: 'usp_00' }), { touched: new Set(), limit: 200 })
  expect(rows.length).toBe(100)
  expect(folds(rows)).toEqual([])
})

test('unfold opens one block and flat opens the whole folder', () => {
  const ctx = { touched: new Set([file(766)]), limit: 200 }
  const folded = under(bigTree(), ctx)
  const first = folded[0]!.node.id
  expect(first).toBe(`${DIR}\u0000${file(0)}`)
  const opened = under(bigTree(1533, [], { unfold: [first] }), ctx)
  expect(files(opened).length).toBe(763 + 7)
  expect(folds(opened)).toEqual([763])
  expect(under(bigTree(1533, [], { flat: [DIR] }), ctx).length).toBe(1533)
})

test('dots only keeps the touched files and their folders, git changes out', () => {
  const t = bigTree(1533, [entry('sub', 'dir')], { git: { [file(1000)]: 'M' }, onlyDots: true })
  const all = visibleRows(t, { touched: new Set([file(5), file(766)]), limit: 200 })
  expect(files(all)).toEqual([name(5), name(766)])
  expect(all.filter(r => r.node.kind === 'dir').map(r => r.node.name)).toEqual(['database', '40-procedure'])
  expect(folds(all)).toEqual([])
})

test('dots only with nothing touched shows nothing', () => {
  expect(visibleRows(bigTree(10, [], { onlyDots: true }), { touched: new Set(), limit: 200 })).toEqual([])
})
