import { expect, test } from 'claude-code/testing'
import { RAMPS } from '../hooks/git'
import { DOT, dotSegs, history } from '../hooks/dots'
import type { Step, StepFile } from '../hooks/replay'

const step = (epoch: number, turn: number, tones: Record<string, string>, files?: Record<string, StepFile>): Step => ({ epoch, turn, tones, ...(files ? { files } : {}) })
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
  const trail = [step(1, 1, { a: 'purple' }), step(2, 1, { a: 'orange' }), step(3, 1, { a: 'green' })]
  expect(history(trail, 'a')).toEqual(['read', 'shell', 'commit'])
  expect(dotSegs(['commit'], 8, 'time')).toEqual([{ t: DOT, c: tone('green') }])
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

test('compact always groups and off draws nothing', () => {
  expect(dotSegs(['read', 'read', 'edit'], 'compact', 'time')).toEqual([
    { t: DOT, c: tone('orange') },
    { t: ` ${DOT}`, c: tone('purple') }, { t: '2', c: RAMPS.purple![1] },
  ])
  expect(dotSegs(['read', 'read', 'edit'], 'off', 'time')).toEqual([])
})
