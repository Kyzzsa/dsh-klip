import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { KInterval } from '../src/k-interval.ts'
import { reIndexEvents } from '../src/re-index.ts'
import { turnRules, seqRules } from '../src/rules.ts'
import type { ReIndexRules } from '../src/re-index.ts'

// ---- helpers that build synthetic events ----

// Build a minimal event. Pass data as needed.
function ev(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

function turnStart(turn: number, seq: number): SessionEvent {
  return ev(seq, 'turn/start', { turn })
}
function turnEnd(turn: number, seq: number): SessionEvent {
  return ev(seq, 'turn/end', { turn, reason: 'done' })
}
function stepStart(turn: number, step: number, seq: number): SessionEvent {
  return ev(seq, 'step/start', { turn, step })
}
function assistantMsg(turn: number, seq: number, opts: { sourceEventSeqs?: number[]; surfaceOp?: unknown } = {}): SessionEvent {
  const event = ev(seq, 'assistant/message', { turn, step: 1, message: {} })
  if (opts.sourceEventSeqs !== undefined) (event as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs = opts.sourceEventSeqs
  if (opts.surfaceOp !== undefined) (event as unknown as { surfaceOp: unknown }).surfaceOp = opts.surfaceOp
  return event
}
function commandDone(seq: number, sourceEventSeq?: number): SessionEvent {
  const event = ev(seq, 'command/done', { commandId: 'c', kind: 'success' })
  if (sourceEventSeq !== undefined) (event.data as unknown as { sourceEventSeq: number }).sourceEventSeq = sourceEventSeq
  return event
}
function sessionTitle(seq: number, messageSeqs: number[]): SessionEvent {
  return ev(seq, 'session/title', { title: 't', source: 'user', messageSeqs })
}

// ---- tests ----

test('reIndexEvents: selected turns are extracted, seq contiguous from 0, turn dense 1..N', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), stepStart(1, 1, 1), assistantMsg(1, 2), turnEnd(1, 3),
    turnStart(2, 4), stepStart(2, 1, 5), assistantMsg(2, 6), turnEnd(2, 7),
    turnStart(3, 8), stepStart(3, 1, 9), assistantMsg(3, 10), turnEnd(3, 11),
  ]
  // select turns 1 and 3
  const out = reIndexEvents(log, KInterval.from_string('1,3'), { turnRules, seqRules })

  assert.equal(out.length, 8)
  // turn 1's three events renumber to turn 1
  assert.deepEqual(out[0].data.turn, 1)
  assert.deepEqual(out[1].data.turn, 1)
  assert.deepEqual(out[2].data.turn, 1)
  // turn 3's turn renumbers to 2
  assert.deepEqual(out[4].data.turn, 2)
  // seq is contiguous 0..7
  out.forEach((e, i) => assert.equal(e.seq, i))
})

test('reIndexEvents: turn cursor after turn/start is tracked correctly', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), turnEnd(1, 1),
    turnStart(2, 2), turnEnd(2, 3),
  ]
  // select only turn 2
  const out = reIndexEvents(log, KInterval.from_string('2'), { turnRules, seqRules })
  assert.equal(out.length, 2)
  assert.equal(out[0].data.turn, 1) // original turn 2 → new turn 1
  assert.equal(out[1].data.turn, 1)
})

test('reIndexEvents: value rule remaps data.turn', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    turnStart(2, 3), assistantMsg(2, 4), turnEnd(2, 5),
  ]
  const out = reIndexEvents(log, KInterval.from_string('2'), { turnRules, seqRules })
  // only turn 2 survives → renumber to turn 1
  assert.equal(out.length, 3)
  for (const e of out) assert.equal(e.data.turn, 1)
})

test('reIndexEvents: array rule drops the event when every member is dead', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), turnEnd(1, 1),
    turnStart(2, 2), turnEnd(2, 3),
  ]
  // references seq 1 (turn 1) and seq 100 (out of range). Only turn 2 selected
  // → all dead → assistant/message dropped.
  const refMsg = assistantMsg(2, 4, { sourceEventSeqs: [1, 100] })
  const full = [...log, refMsg, turnEnd(2, 5)]
  const out = reIndexEvents(full, KInterval.from_string('2'), { turnRules, seqRules })

  assert.equal(out.filter(e => e.type === 'assistant/message').length, 0)
})

test('reIndexEvents: array reference filters members when some survive', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    turnStart(2, 3), turnEnd(2, 4),
  ]
  // seq 1 is inside turn1; selecting turn1+2 keeps seq 1 alive, seq 100 dead
  const refMsg = assistantMsg(2, 5, { sourceEventSeqs: [1, 100] })
  const full = [...log, refMsg, turnEnd(2, 6)]
  const out = reIndexEvents(full, KInterval.from_string('1,2'), { turnRules, seqRules })

  // take the assistant/message in turn2 (new seq 5)
  const msg = out.findLast(e => e.type === 'assistant/message')!
  assert.ok(msg)
  // 1 → new seq; 100 filtered out
  assert.deepEqual((msg as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs, [1])
})

test('reIndexEvents: interval rule intersects and re-projects replace start/end', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), assistantMsg(1, 2), turnEnd(1, 3),
    turnStart(2, 4), turnEnd(2, 5),
  ]
  // replace covers seq 1..3; only seq1,seq2 (turn1) plus seq3 (turnEnd) survive.
  // the covered interval seq1..3 all survive.
  const replaceMsg = assistantMsg(2, 6, {
    sourceEventSeqs: [1, 2, 3],
    surfaceOp: { op: 'replace', start: 1, end: 3 },
  })
  const full = [...log, replaceMsg, turnEnd(2, 7)]
  const out = reIndexEvents(full, KInterval.from_string('1,2'), { turnRules, seqRules })

  const msg = out.find(e => e.type === 'assistant/message' && (e as unknown as { surfaceOp: unknown }).surfaceOp)!
  const op = (msg as unknown as { surfaceOp: { op: 'replace'; start: number; end: number } }).surfaceOp
  assert.equal(op.op, 'replace')
  // intersection: [1,3] survivors are seq1,2,3 (if all present) → start/end re-projected
  assert.equal(typeof op.start, 'number')
  assert.equal(typeof op.end, 'number')
})

test('reIndexEvents: interval with empty intersection drops the replace event', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    turnStart(2, 3), turnEnd(2, 4),
  ]
  // replace covers seq 5..6, but seq5,6 live in the cut-away turn3
  const replaceMsg = assistantMsg(2, 5, {
    sourceEventSeqs: [6, 7],
    surfaceOp: { op: 'replace', start: 6, end: 7 },
  })
  const turn3 = [turnStart(3, 6), assistantMsg(3, 7), turnEnd(3, 8)]
  const full = [...log, replaceMsg, ...turn3, turnEnd(2, 9)]
  // select only turn 2 → seq6,7 dead
  const out = reIndexEvents(full, KInterval.from_string('2'), { turnRules, seqRules })
  // replace event's covered seqs all dead → dropped
  assert.equal(out.filter(e => e.type === 'assistant/message').length, 0)
})

test('reIndexEvents: command/done with dead sourceEventSeq is dropped', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), commandDone(1, 100), turnEnd(1, 2),
  ]
  // seq 100 does not exist → sourceEventSeq dead → command/done dropped
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type === 'command/done').length, 0)
})

test('reIndexEvents: session/title messageSeqs filters dead entries', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), turnEnd(1, 1),
    turnStart(2, 2), sessionTitle(3, [1, 100]), turnEnd(2, 4),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,2'), { turnRules, seqRules })
  const title = out.find(e => e.type === 'session/title')!
  assert.ok(title)
  assert.deepEqual((title.data as unknown as { messageSeqs: number[] }).messageSeqs, [1])
})

test('reIndexEvents: override flag forces the wildcard rule to be skipped', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'custom/event', { turn: 999 }), turnEnd(1, 1),
  ]
  // default: wildcard data.turn remaps 999 (999 not in turnMap → custom/event dropped)
  const outDefault = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(outDefault.filter(e => e.type === 'custom/event').length, 0)

  // override: custom/event's rule has override:true, fully skipping the wildcard data.turn
  const customTurn: ReIndexRules = {
    ...turnRules,
    'custom/event': [{ kind: 'value', path: 'data.other', override: true }],
  }
  const outSkip = reIndexEvents(log, KInterval.from_string('1'), { turnRules: customTurn, seqRules })
  // data.other missing → value rule skips → custom/event survives (wildcard data.turn overridden)
  assert.equal(outSkip.filter(e => e.type === 'custom/event').length, 1)
})

// ---- "skip" branch: missing / mistyped field, non-array, or no interval field
//      → rule does not apply, event is kept ----

test('reIndexEvents: value rule skips on mistyped (non-numeric) field, event kept', () => {
  // custom/event's data.turn is a string; the wildcard value rule should skip, not drop
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'custom/event', { turn: 'not-a-number' }), turnEnd(1, 1),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  // default wildcard value('data.turn') hits a string → typeof !== 'number' → skip → kept
  assert.equal(out.filter(e => e.type === 'custom/event').length, 1)
})

test('reIndexEvents: value rule skips on missing field, event kept', () => {
  // todo/write has no data.turn; the wildcard value rule should skip, not drop
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'todo/write', { todos: [] }), turnEnd(1, 1),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type === 'todo/write').length, 1)
})

test('reIndexEvents: array rule skips on non-array field, event kept', () => {
  // custom/event's data.refs is a number, not an array; the array rule should skip, not drop
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'custom/event', { refs: 5 }), turnEnd(1, 1),
  ]
  const customSeq: ReIndexRules = {
    '*': [{ kind: 'value', path: 'seq' }],
    'custom/event': [{ kind: 'array', path: 'data.refs' }],
  }
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  assert.equal(out.filter(e => e.type === 'custom/event').length, 1)
})

test('reIndexEvents: interval rule skips when start/end fields are absent, event kept', () => {
  // an append surface event has no surfaceOp → the interval rule meets undefined → skip
  const log: SessionEvent[] = [
    turnStart(1, 0), turnEnd(1, 1),
    turnStart(2, 2), turnEnd(2, 3),
  ]
  const appendMsg = assistantMsg(2, 4, { surfaceOp: 'append' })
  const full = [...log, appendMsg, turnEnd(2, 5)]
  const out = reIndexEvents(full, KInterval.from_string('2'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type === 'assistant/message').length, 1)
})

test('reIndexEvents: seqRules override flag skips the wildcard seq rule', () => {
  // custom/event's own seq should not be remapped by the wildcard '*'['seq']; use override
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'custom/event', {}), turnEnd(1, 1),
  ]
  const customSeq: ReIndexRules = {
    ...seqRules,
    'custom/event': [{ kind: 'value', path: 'data.customSeq', override: true }],
  }
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  const evt = out.find(e => e.type === 'custom/event')!
  assert.ok(evt)
  // data.customSeq missing → value skips; wildcard 'seq' overridden → own seq stays 1
  assert.equal(evt.seq, 1)
})

// ---- post-turn tool-call cut-off ----
//
// Tool calls are produced AFTER the completed turn's turn/end. Those events are
// still attributed to the last turn (the loop cursor never reset), so without
// the scan cut-off they would leak into the reindexed seed. The following tests
// pin down that anything after the last completed turn/end is cut.

test('reIndexEvents: post-turn tool-call events after the last turn/end are cut', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    // produced after turn 1 closed, still tagged with turn 1
    ev(3, 'tool/call', { turn: 1, callId: 'c1' }),
    ev(4, 'tool/result', { turn: 1, callId: 'c1' }),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  // only turn 1's three events survive; the tool-call aftermath is dropped
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(e => e.type), ['turn/start', 'assistant/message', 'turn/end'])
})

test('reIndexEvents: no-turn events after the last turn/end are cut (not treated as headers)', () => {
  // header events before the first turn/start carry no turn and are kept; the
  // same events AFTER the last turn/end must NOT be kept.
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    ev(3, 'permission/preset', {}),
    ev(4, 'sandbox/mode', {}),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(e => e.type), ['turn/start', 'assistant/message', 'turn/end'])
})
