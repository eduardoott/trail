// Hook latency and render cost, a ring of 256 samples a key, kept only while the metrics option is on.
// The engine reads each hook as a function literal and refuses a wrapped one, so the timing goes inside it, through measure.
export type Stat = { n: number; ownP50: number; ownP95: number; wallP95: number }
type Agg = { n: number; own: number[]; wall: number[] }
const RING = 256
const aggs = new Map<string, Agg>()
export let enabled = false

export function enable(on: boolean): void {
  enabled = on
  aggs.clear()
}

// own: the hook's own time; wall: with what it awaited. A size (state:*) goes in as own alone, in bytes.
export function record(key: string, own: number, wall = own): void {
  const a = aggs.get(key) ?? { n: 0, own: [], wall: [] }
  aggs.set(key, a)
  a.own[a.n % RING] = own
  a.wall[a.n % RING] = wall
  a.n += 1
}

const pct = (xs: number[], q: number) => [...xs].sort((x, y) => x - y)[Math.floor((xs.length - 1) * q)] ?? 0
const round = (x: number) => Math.round(x * 100) / 100

export function snapshot(): Record<string, Stat> {
  const keys = [...aggs.keys()].sort()
  return Object.fromEntries(keys.map(k => [k, stat(aggs.get(k)!)]))
}

const stat = (a: Agg): Stat => ({ n: a.n, ownP50: round(pct(a.own, 0.5)), ownP95: round(pct(a.own, 0.95)), wallP95: round(pct(a.wall, 0.95)) })

// The snapshot as an aligned table: ms for the hooks, whole bytes for state:*.
export function lines(): string[] {
  const fmt = (k: string, x: number) => (k.startsWith('state:') ? String(Math.round(x)) : x.toFixed(2))
  const rows = Object.entries(snapshot()).map(([k, s]) => [k, String(s.n), fmt(k, s.ownP50), fmt(k, s.ownP95), fmt(k, s.wallP95)])
  const all = [['key', 'n', 'own p50', 'own p95', 'wall p95'], ...rows]
  const w = all[0]!.map((_, i) => Math.max(...all.map(r => r[i]!.length)))
  return all.map(r => r.map((c, i) => (i ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join('  '))
}

// mark wraps the awaits that are not the hook's own work (next(e), $ calls): their time counts for wall alone.
export async function measure<T>(key: string, body: (mark: <R>(p: Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  if (!enabled) return body(p => p)
  let waited = 0
  const mark = async <R>(p: Promise<R>): Promise<R> => {
    const s = performance.now()
    try {
      return await p
    } finally {
      waited += performance.now() - s
    }
  }
  const t0 = performance.now()
  try {
    return await body(mark)
  } finally {
    const wall = performance.now() - t0
    record(key, Math.max(0, wall - waited), wall)
  }
}
