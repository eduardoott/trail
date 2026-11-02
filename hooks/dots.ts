// The dots after a file's name: one per thing Claude did to it, over the session's steps.
import type { Seg } from './rows'
import { RAMPS } from './git'
import { BRANCH_ROW, KIND_RAMP, type Kind, kindOf, type Step } from './replay'
import { ancestorsOf } from './tree'

export const DOT = '•'

export type DotsLimit = number | 'compact' | 'off'
export type DotsOrder = 'time' | 'kind'
// A commit lights its files green: a dot of its own, not a shell write.
export type DotKind = Kind | 'commit'
// Right to left when grouped by kind: reads against the date column, then edits, then the rest.
const BY_KIND: DotKind[] = ['commit', 'shell', 'gone', 'born', 'edit', 'read']

// Merge, rebase and cherry-pick paint their rewritten files purple, the tone kindOf reads as a read.
const REWRITERS = ['git merge', 'git rebase', 'git cherry-pick']

// What the steps did to every file they name, oldest first, in one pass over the trail (the render asks for every
// row of every frame). The same thing done again right after, inside one answer, is one dot.
export function histories(trail: Step[]): Map<string, DotKind[]> {
  const out = new Map<string, DotKind[]>()
  const last = new Map<string, { turn: number; kind: DotKind }>()
  for (const step of trail) {
    const names = step.names ?? []
    const commit = names.includes('git commit')
    const rewrite = REWRITERS.some(n => names.includes(n))
    for (const file of Object.keys(step.tones)) {
      const base = kindOf(step, file)
      // A step mixing a real Read with a merge is accepted as imprecise: the shell wins.
      const kind: DotKind = base === 'shell' && step.tones[file] === 'green' ? (commit ? 'commit' : 'shell') : base === 'read' && rewrite ? 'shell' : base
      const prev = last.get(file)
      if (prev && prev.turn === step.turn && prev.kind === kind) continue
      const kinds = out.get(file)
      if (kinds) kinds.push(kind)
      else out.set(file, [kind])
      last.set(file, { turn: step.turn, kind })
    }
  }
  return out
}

export function history(trail: Step[], file: string): DotKind[] {
  return histories(trail).get(file) ?? []
}

// What a closed folder sums: the kinds of every file under it, up to the root (which has no row).
export function folders(all: Map<string, DotKind[]>, root: string): Map<string, DotKind[]> {
  const out = new Map<string, DotKind[]>()
  for (const [file, kinds] of all) {
    if (file === BRANCH_ROW) continue
    for (const dir of ancestorsOf(file, root)) {
      const sum = out.get(dir)
      if (sum) sum.push(...kinds)
      else out.set(dir, [...kinds])
    }
  }
  return out
}

// Tone 3 of the kind's ramp: the settled tone of a lit row. The count beside a grouped dot takes tone 1: a terminal
// has no smaller font, superscript read too small and askew, so the count is quieter instead.
const toneOf = (kind: DotKind, at = 3): string => RAMPS[kind === 'shell' ? 'teal' : kind === 'commit' ? 'green' : KIND_RAMP[kind]]![at]!

// The segments of the dots, left to right, glued together. Past the limit the row goes compact: one dot a kind
// with its count, a space between kinds.
export function dotSegs(kinds: DotKind[], limit: DotsLimit, order: DotsOrder): Seg[] {
  if (limit === 'off' || kinds.length === 0) return []
  if (limit === 'compact' || kinds.length > limit) {
    const n = new Map<DotKind, number>()
    for (const k of kinds) n.set(k, (n.get(k) ?? 0) + 1)
    return BY_KIND.filter(k => n.has(k)).flatMap((k, i) => {
      const dot = { t: `${i ? ' ' : ''}${DOT}`, c: toneOf(k) }
      return n.get(k)! > 1 ? [dot, { t: String(n.get(k)), c: toneOf(k, 1) }] : [dot]
    })
  }
  const ordered = order === 'kind' ? BY_KIND.flatMap(k => kinds.filter(x => x === k)) : [...kinds].reverse()
  return ordered.map(k => ({ t: DOT, c: toneOf(k) }))
}
