import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KInterval } from '../src/k-interval.ts'

const LEN = 10

const inst = (text: string, len = LEN) => KInterval.from_string(text).instantiate(len)

test('a single number selects one point', () => {
  assert.deepEqual(inst('3'), [{ s: 3, e: 3 }])
})

test('mirror mapping + intersection with [1,10]', () => {
  assert.deepEqual(inst('11'), []) // single point 11 is fully out of range → empty
  assert.deepEqual(inst('-1'), [{ s: 10, e: 10 }]) // -1 → len=10
  assert.deepEqual(inst('4 .. 12'), [{ s: 4, e: 10 }]) // 12 intersected with [1,10] clamps to 10
  assert.deepEqual(inst('-2 .. -1'), [{ s: 9, e: 10 }]) // -2→9, -1→10
  assert.deepEqual(inst('12..'), []) // start 12 out of range → empty
  assert.deepEqual(inst('..14'), [{ s: 1, e: 10 }]) // end 14 intersected, clamps to 10
})

test('interval a..b, closed on both ends', () => {
  assert.deepEqual(inst('1 .. 2'), [{ s: 1, e: 2 }])
  assert.deepEqual(inst('2 .. 5'), [{ s: 2, e: 5 }])
})

test('a..b without spaces parses the same', () => {
  assert.deepEqual(inst('1..2'), [{ s: 1, e: 2 }])
  assert.deepEqual(inst('2..5'), [{ s: 2, e: 5 }])
})

test('mixed spaces and no spaces', () => {
  assert.deepEqual(inst('1..9, not 3 .. 6'), [
    { s: 1, e: 2 },
    { s: 7, e: 9 },
  ])
})

test('start past end → clause invalid → empty', () => {
  assert.deepEqual(inst('5 .. 2'), [])
  assert.deepEqual(inst('5..2'), [])
  assert.deepEqual(inst('1 .. 9, 5 .. 2'), [{ s: 1, e: 9 }])
})

test('.. = the full set', () => {
  assert.deepEqual(inst('..'), [{ s: 1, e: 10 }])
})

test('a.. is equivalent to a..-1', () => {
  assert.deepEqual(inst('3..'), [{ s: 3, e: 10 }])
  assert.deepEqual(inst('3 ..'), [{ s: 3, e: 10 }])
})

test('..b is equivalent to 1..b', () => {
  assert.deepEqual(inst('..3'), [{ s: 1, e: 3 }])
  assert.deepEqual(inst('.. 3'), [{ s: 1, e: 3 }])
})

test('a 0-based left end is clamped to 1', () => {
  assert.deepEqual(inst('0 .. 2'), [{ s: 1, e: 2 }])
})

test('open-ended combination: .. with exclusion', () => {
  assert.deepEqual(inst('.., not 3 .. 6'), [
    { s: 1, e: 2 },
    { s: 7, e: 10 },
  ])
})

test('an unrecognizable body → empty', () => {
  assert.deepEqual(inst('hello'), [])
})

test('not on a single point → the full set is excluded → empty', () => {
  assert.deepEqual(inst('not 3'), [])
  assert.deepEqual(inst('not3'), [])
})

test('not on an unrecognizable body → the whole clause dropped → empty', () => {
  assert.deepEqual(inst('not hello'), [])
})

test('include minus exclude: from 1..2 and 5..7 exclude 1..6', () => {
  assert.deepEqual(inst('1 .. 2, 5 .. 7, not 1 .. 6'), [
    { s: 7, e: 7 },
  ])
})

test('an exclusion in the middle of an interval produces two gaps', () => {
  assert.deepEqual(inst('1 .. 9, not 3 .. 6'), [
    { s: 1, e: 2 },
    { s: 7, e: 9 },
  ])
})

test('multiple exclusions carve out successive gaps', () => {
  assert.deepEqual(inst('1 .. 9, not 2 .. 3, not 5 .. 6'), [
    { s: 1, e: 1 },
    { s: 4, e: 4 },
    { s: 7, e: 9 },
  ])
})

test('exclusion reaching the include start: not 1..2 leaves 3..9', () => {
  assert.deepEqual(inst('1 .. 9, not 1 .. 2'), [{ s: 3, e: 9 }])
})

test('excluding everything → empty', () => {
  assert.deepEqual(inst('1 .. 9, not 1 .. 9'), [])
})

test('adjacent intervals merge: 1..2 and 2..4 → 1..4', () => {
  assert.deepEqual(inst('1 .. 2, 2 .. 4'), [{ s: 1, e: 4 }])
})

test('empty string / whitespace → empty', () => {
  assert.deepEqual(inst(''), [])
  assert.deepEqual(inst('   '), [])
})

test('len <= 0 → empty', () => {
  assert.deepEqual(inst('..', 0), [])
  assert.deepEqual(inst('1 .. 2', -1), [])
})

test('parsing keeps raw endpoints (incl. the -1 sentinel), no instantiation', () => {
  assert.deepEqual(KInterval.from_string('3..').includes, [{ s: 3, e: -1 }])
  assert.deepEqual(KInterval.from_string('..').includes, [{ s: 1, e: -1 }])
  assert.deepEqual(KInterval.from_string('not 2 .. 5').excludes, [{ s: 2, e: 5 }])
})

test('from_string is pure: no shared arrays, independent across calls', () => {
  const a = KInterval.from_string('1 .. 2')
  const b = KInterval.from_string('1 .. 2')
  assert.notStrictEqual(a.includes, b.includes)
  assert.notStrictEqual(a, b)
  assert.deepEqual(a.includes, b.includes)
})

test('instantiate is pure: does not mutate this, keeps raw endpoints, idempotent', () => {
  const k = KInterval.from_string('1 .. 2, not 1')
  const before = JSON.stringify(k.includes)
  const first = k.instantiate(LEN)
  const second = k.instantiate(LEN)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(k.includes), before)
  assert.notStrictEqual(first, second)
  // mutating the returned array does not affect the next call
  first.push({ s: 9, e: 9 })
  assert.deepEqual(k.instantiate(LEN), second)
})
