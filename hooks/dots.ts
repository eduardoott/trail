// The dots after a file's name: one per thing Claude did to it, over the session's steps.
import type { Seg } from './rows'
import { RAMPS } from './git'
import { KIND_RAMP, type Kind, kindOf, type Step } from './replay'

export const DOT = '•'
// The count is drawn in superscript: a terminal has no smaller font, and it keeps the dot the loud part.
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const small = (n: number) => `⁽${[...String(n)].map(d => SUP[Number(d)]).join('')}⁾`

export type DotsLimit = number | 'compact' | 'off'
export type DotsOrder = 'time' | 'kind'
// A commit lights its files green: a dot of its own, not a shell write.
export type DotKind = Kind | 'commit'
// Right to left when grouped by kind: reads against the date column, then edits, then the rest.
const BY_KIND: DotKind[] = ['commit', 'shell', 'gone', 'born', 'edit', 'read']

// What the steps did to the file, oldest first. The same thing done again inside one answer is one dot.
export function history(trail: Step[], file: string): DotKind[] {
  const out: DotKind[] = []
  let last: { turn: number; kind: DotKind } | null = null
  for (const step of trail) {
    if (!(file in step.tones)) continue
    const base = kindOf(step, file)
    const kind: DotKind = base === 'shell' && step.tones[file] === 'green' ? 'commit' : base
    if (last && last.turn === step.turn && last.kind === kind) continue
    out.push(kind)
    last = { turn: step.turn, kind }
  }
  return out
}

// Tone 3 of the kind's ramp: the settled tone of a lit row.
const toneOf = (kind: DotKind): string => RAMPS[kind === 'shell' ? 'teal' : kind === 'commit' ? 'green' : KIND_RAMP[kind]]![3]!

// The segments of the dots, left to right, glued together. Past the limit the row goes compact: one dot a kind
// with its count, a space between kinds.
export function dotSegs(kinds: DotKind[], limit: DotsLimit, order: DotsOrder): Seg[] {
  if (limit === 'off' || kinds.length === 0) return []
  if (limit === 'compact' || kinds.length > limit) {
    const n = new Map<DotKind, number>()
    for (const k of kinds) n.set(k, (n.get(k) ?? 0) + 1)
    return BY_KIND.filter(k => n.has(k)).map((k, i) => ({ t: `${i ? ' ' : ''}${DOT}${(n.get(k) ?? 0) > 1 ? small(n.get(k)!) : ''}`, c: toneOf(k) }))
  }
  const ordered = order === 'kind' ? BY_KIND.flatMap(k => kinds.filter(x => x === k)) : [...kinds].reverse()
  return ordered.map(k => ({ t: DOT, c: toneOf(k) }))
}
