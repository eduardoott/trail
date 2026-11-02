import { expect, test } from 'claude-code/testing'
import { enable, lines, measure, record, snapshot } from '../hooks/metrics'

// Burns the CPU for ms: own time when it runs in the body, awaited time when it runs inside a marked promise.
const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {}
}
// The burn runs after the first await, so mark has taken its start by then.
const spin = async (ms: number) => {
  await null
  busy(ms)
}

test('measure records own and wall apart: a marked wait counts for wall alone', async () => {
  enable(true)
  const out = await measure('k', async mark => {
    busy(2)
    await mark(spin(8))
    busy(2)
    return 'done'
  })
  expect(out).toBe('done')
  const s = snapshot().k!
  expect(s.n).toBe(1)
  expect(s.wallP95).toBeGreaterThanOrEqual(12)
  expect(s.ownP50).toBeLessThan(8)
  expect(s.ownP50).toBeLessThan(s.wallP95)
})

test('off, measure runs the body with a plain mark and keeps nothing', async () => {
  enable(false)
  const out = await measure('k', async mark => (await mark(Promise.resolve(3))) + 1)
  expect(out).toBe(4)
  expect(snapshot()).toEqual({})
})

test('snapshot gives p50 and p95 of own and p95 of wall, and lines lays them out as a table', () => {
  enable(true)
  for (let i = 1; i <= 100; i += 1) record('k', i, i * 2)
  expect(snapshot()).toEqual({ k: { n: 100, ownP50: 50, ownP95: 95, wallP95: 190 } })
  const [head, row] = lines()
  expect(head).toMatch(/^key +n +own p50 +own p95 +wall p95$/)
  expect(row).toMatch(/^k +100 +50\.00 +95\.00 +190\.00$/)
})

test('the ring keeps the last 256 samples a key, the count goes on', () => {
  enable(true)
  for (let i = 1; i <= 300; i += 1) record('k', i)
  expect(snapshot().k).toEqual({ n: 300, ownP50: 172, ownP95: 287, wallP95: 287 })
})
