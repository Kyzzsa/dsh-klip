import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { KInterval } from '../src/k-interval.ts'
import { reIndexEvents } from '../src/re-index.ts'
import { turnRules, seqRules } from '../src/rules.ts'
import type { TurnReIndexRules, SeqReIndexRules } from '../src/rules.ts'

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
// A user/message surface event (message-producing, carries a surfaceOp marker).
function userMsg(turn: number, seq: number, opts: { sourceEventSeqs?: number[]; surfaceOp?: unknown } = {}): SessionEvent {
  const event = ev(seq, 'user/message', { turn, step: 1, message: {} })
  if (opts.sourceEventSeqs !== undefined) (event as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs = opts.sourceEventSeqs
  if (opts.surfaceOp !== undefined) (event as unknown as { surfaceOp: unknown }).surfaceOp = opts.surfaceOp
  else (event as unknown as { surfaceOp: unknown }).surfaceOp = 'append'
  return event
}
// A tool/result surface event (message-producing, carries a surfaceOp marker).
function toolResult(turn: number, seq: number, opts: { sourceEventSeqs?: number[]; surfaceOp?: unknown } = {}): SessionEvent {
  const event = ev(seq, 'tool/result', { turn, step: 1, message: { role: 'tool', content: [] } })
  if (opts.sourceEventSeqs !== undefined) (event as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs = opts.sourceEventSeqs
  if (opts.surfaceOp !== undefined) (event as unknown as { surfaceOp: unknown }).surfaceOp = opts.surfaceOp
  else (event as unknown as { surfaceOp: unknown }).surfaceOp = 'append'
  return event
}
// A non-surface tool/call record (not surface-eligible).
function toolCall(turn: number, seq: number): SessionEvent {
  return ev(seq, 'tool/call', { turn, step: 1, callId: `c${seq}` })
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
    turnStart(1, 0), assistantMsg(1, 1, { surfaceOp: 'append' }), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4), turnEnd(2, 5),
  ]
  // replace covers surface nodes seq 1..2 (seq3 is a turn boundary, not surface).
  const replaceMsg = assistantMsg(2, 6, {
    sourceEventSeqs: [1, 2, 3],
    surfaceOp: { op: 'replace', start: 1, end: 3 },
  })
  const full = [...log, replaceMsg, turnEnd(2, 7)]
  const out = reIndexEvents(full, KInterval.from_string('1,2'), { turnRules, seqRules })

  const msg = out.find(e => (e as unknown as { surfaceOp?: unknown }).surfaceOp?.['op'] === 'replace')!
  const op = (msg as unknown as { surfaceOp: { op: 'replace'; start: number; end: number } }).surfaceOp
  assert.equal(op.op, 'replace')
  // the interval re-projects onto the surviving surface nodes (seq1, seq2)
  assert.equal(op.start, 1)
  assert.equal(op.end, 2)
})

test('reIndexEvents: a whole compaction block is skipped (records and checkpoint)', () => {
  // A completed /compact inside turn2: start → summary → checkpoint → end. The
  // whole block must leave the seed — no compaction/* and no checkpoint — so the
  // token fold never sees an orphan replace.
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4),
    ev(5, 'compaction/start', { turn: 2, compactionId: 'c1' }),
    ev(6, 'compaction/summary', { turn: 2, compactionId: 'c1', shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 10, summary: [], provider: 'p', model: 'm' }),
    userMsg(7, { sourceEventSeqs: [5, 6, 1, 2], surfaceOp: { op: 'replace', start: 1, end: 2 } }),
    ev(8, 'compaction/end', { turn: 2, compactionId: 'c1' }),
    turnEnd(2, 9),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,2'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type.startsWith('compaction/')).length, 0)
  // the checkpoint is part of the block and must not leak
  assert.equal(out.filter(e => e.type === 'user/message').length, 1) // only turn1's append remains
  assert.doesNotThrow(() => foldSurface(out))
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

test('reIndexEvents: command/done survives a dead sourceEventSeq (no reference rule)', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), commandDone(1, 100), turnEnd(1, 2),
  ]
  // command/done carries no reference rule, so a dead sourceEventSeq cannot sink
  // it (the UI pairs it with command/run by commandId — a dropped done would
  // leave the command rendering as still executing/calling forever).
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type === 'command/done').length, 1)
})

test('reIndexEvents: array with keep survives an all-dead refs, emptied to []', () => {
  const customSeq: SeqReIndexRules = {
    ...seqRules,
    'custom/event': { rules: [{ kind: 'array', path: 'data.refs', keep: true }] },
  }
  const log: SessionEvent[] = [
    turnStart(1, 0), ev(1, 'custom/event', { turn: 1, refs: [90, 91] }), turnEnd(1, 2),
  ]
  // seqs 90,91 both dead → keep: true keeps the event, array emptied to []
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  const evt = out.find(e => e.type === 'custom/event')!
  assert.ok(evt)
  assert.deepEqual((evt.data as unknown as { refs: number[] }).refs, [])
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

  // override: custom/event's cell has override:true, fully skipping the wildcard data.turn
  const customTurn: TurnReIndexRules = {
    ...turnRules,
    'custom/event': { override: true, rules: [{ kind: 'value', path: 'data.other' }] },
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
  const customSeq: SeqReIndexRules = {
    '*': { rules: [{ kind: 'value', path: 'seq' }] },
    'custom/event': { rules: [{ kind: 'array', path: 'data.refs' }] },
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
  const customSeq: SeqReIndexRules = {
    ...seqRules,
    'custom/event': { override: true, rules: [{ kind: 'value', path: 'data.customSeq' }] },
  }
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  const evt = out.find(e => e.type === 'custom/event')!
  assert.ok(evt)
  // data.customSeq missing → value skips; wildcard 'seq' overridden → own seq stays 1
  assert.equal(evt.seq, 1)
})

// ---- no tail cut-off ----
//
// There is no special case that stops the scan at the last completed turn's
// turn/end. Trailing records (tool calls, no-turn summaries, /compact output)
// produced after that point are filtered purely by turn membership: anything
// attributed to a selected turn survives, anything in an unselected turn drops.

test('reIndexEvents: trailing events after the last turn/end are kept when in a selected turn', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    // produced after turn 1 closed, still tagged with turn 1
    ev(3, 'tool/call', { turn: 1, callId: 'c1' }),
    ev(4, 'tool/result', { turn: 1, callId: 'c1' }),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  // no cut-off: the trailing tool-call records survive with turn 1
  assert.equal(out.length, 5)
  assert.deepEqual(out.map(e => e.type), ['turn/start', 'assistant/message', 'turn/end', 'tool/call', 'tool/result'])
})

test('reIndexEvents: no-turn trailing events are attributed to the last turn and kept', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    ev(3, 'permission/preset', {}),
    ev(4, 'sandbox/mode', {}),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  // the turn cursor still points at turn 1, so these no-turn records keep it and survive
  assert.equal(out.length, 5)
  assert.deepEqual(out.map(e => e.type), ['turn/start', 'assistant/message', 'turn/end', 'permission/preset', 'sandbox/mode'])
})

test('reIndexEvents: events in an unselected in-progress turn after the last turn/end are dropped', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), assistantMsg(1, 1), turnEnd(1, 2),
    turnStart(2, 3), assistantMsg(2, 4),
  ]
  // select only turn 1; the open turn 2 is not in turnMap, so it is dropped
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(e => e.type), ['turn/start', 'assistant/message', 'turn/end'])
})

test('reIndexEvents: no completed turn/end yields an empty seed (early return)', () => {
  // only an in-progress turn exists (no turn/end) → nothing is selectable
  const log: SessionEvent[] = [
    ev(0, 'permission/preset', {}),
    turnStart(1, 1), assistantMsg(1, 2),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules })
  assert.equal(out.length, 0)
})

// ---- surface-replay validity ----
//
// Real surface replacements come only from compaction/prune blocks, which are
// skipped whole (see the skip-block tests). These standalone replaces document
// the plain interval rule on a replacement outside any block: it re-projects
// `surfaceOp.start/end` onto the FIRST/LAST surviving surface-eligible seq in the
// shadowed range — never a non-surface survivor (e.g. a tool/call) — and the
// seed must replay cleanly through dsh-session's real `foldSurface`.

test('reIndexEvents: standalone replace re-projects onto surface survivors (tool/call inside range)', () => {
  // turn1's u/a are cut away; the replace in turn3 shadowed [1..7] which also
  // contains turn2's tool/call (non-surface). The re-projected start must land
  // on a surface survivor (turn2's tool/result), not on the tool/call.
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4), toolCall(2, 5), toolResult(2, 6), assistantMsg(2, 7, { surfaceOp: 'append' }), turnEnd(2, 8),
    turnStart(3, 9),
    userMsg(3, 10, { sourceEventSeqs: [1, 2, 6, 7], surfaceOp: { op: 'replace', start: 1, end: 7 } }),
    turnEnd(3, 11),
  ]
  const out = reIndexEvents(log, KInterval.from_string('2,3'), { turnRules, seqRules })
  const replace = out.find(e => e.type === 'user/message' && (e as unknown as { surfaceOp?: unknown }).surfaceOp?.['op'] === 'replace')!
  assert.ok(replace)
  const op = (replace as unknown as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp
  const surfaceSeqs = out.map((e, i) => (['user/message', 'assistant/message', 'tool/result'].includes(e.type) ? i : -1)).filter(i => i >= 0)
  assert.ok(surfaceSeqs.includes(op.start))
  assert.ok(surfaceSeqs.includes(op.end))
  assert.doesNotThrow(() => foldSurface(out))
})

test('reIndexEvents: standalone replace with a fully-cut shadowed range is dropped', () => {
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4), userMsg(2, 5), assistantMsg(2, 6, { surfaceOp: 'append' }), turnEnd(2, 7),
    turnStart(3, 8),
    userMsg(3, 9, { sourceEventSeqs: [1, 2, 5, 6], surfaceOp: { op: 'replace', start: 1, end: 6 } }),
    turnEnd(3, 10),
  ]
  // select only turn3 → every shadowed surface seq (all in turns 1,2) is dead
  const out = reIndexEvents(log, KInterval.from_string('3'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type === 'user/message').length, 0)
  assert.doesNotThrow(() => foldSurface(out))
})

test('reIndexEvents: standalone replace shrinks when only a prefix of the span survives', () => {
  // the replace in turn3 shadowed [1..6] (turn1+turn2). Cut turn2 → turn2's
  // seqs 5,6 are gone; the interval re-projects onto turn1's surviving u/a.
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4), userMsg(2, 5), assistantMsg(2, 6, { surfaceOp: 'append' }), turnEnd(2, 7),
    turnStart(3, 8),
    userMsg(3, 9, { sourceEventSeqs: [1, 2, 5, 6], surfaceOp: { op: 'replace', start: 1, end: 6 } }),
    turnEnd(3, 10),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,3'), { turnRules, seqRules })
  const replace = out.find(e => e.type === 'user/message' && (e as unknown as { surfaceOp?: unknown }).surfaceOp?.['op'] === 'replace')!
  assert.ok(replace)
  const op = (replace as unknown as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp
  assert.equal(op.start, 1)
  assert.equal(op.end, 2)
  assert.doesNotThrow(() => foldSurface(out))
})

// ---- skip blocks ----
//
// A compaction is one whole block ([compaction/start .. compaction/end], or
// [compaction/prune .. its tool/result replacement]) that is excluded from the
// seed in full — records and the summarizing checkpoint alike — so neither a
// compact's bookkeeping nor its compression effect leaks into the child.

test('reIndexEvents: an interrupted compaction block is skipped', () => {
  // A compaction that was interrupted/failed: start + end(with error), no
  // summary and no checkpoint. Both ends of the block are dropped.
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4),
    ev(5, 'compaction/start', { turn: 2, compactionId: 'c1' }),
    ev(6, 'compaction/end', { turn: 2, compactionId: 'c1', error: 'aborted' }),
    turnEnd(2, 7),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,2'), { turnRules, seqRules })
  assert.equal(out.filter(e => e.type.startsWith('compaction/')).length, 0)
  assert.doesNotThrow(() => foldSurface(out))
})

test('reIndexEvents: an unmatched compaction/start does not hide the following turn', () => {
  // A failed close deliberately leaves an unmatched compaction/start (no end).
  // The skip block must be bounded to its turn so turn3's content still lands.
  const log: SessionEvent[] = [
    turnStart(1, 0), userMsg(1, 1), assistantMsg(1, 2, { surfaceOp: 'append' }), turnEnd(1, 3),
    turnStart(2, 4),
    ev(5, 'compaction/start', { turn: 2, compactionId: 'c1' }),
    userMsg(6, { sourceEventSeqs: [1, 2], surfaceOp: { op: 'replace', start: 1, end: 2 } }),
    turnEnd(2, 7),
    turnStart(3, 8), userMsg(3, 9), assistantMsg(3, 10, { surfaceOp: 'append' }), turnEnd(3, 11),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,2,3'), { turnRules, seqRules })
  // compaction/start and the checkpoint inside the open block are gone
  assert.equal(out.filter(e => e.type.startsWith('compaction/')).length, 0)
  // turn3's message survives (the block did not swallow the next turn)
  assert.ok(out.find(e => e.type === 'user/message' && (e as unknown as { surfaceOp: unknown }).surfaceOp === 'append' && e.data.turn === 3))
  assert.doesNotThrow(() => foldSurface(out))
})

test('reIndexEvents: skip-n drops a prune pair (compaction/prune + tool/result replacement)', () => {
  // A prune in turn2 shortens the turn1 tool/result (seq 2): it is immediately
  // preceded by a compaction/prune metering event and lands a tool/result
  // replacement. skip-n (n=1) drops both, leaving the original tool/result.
  const log: SessionEvent[] = [
    turnStart(1, 0), toolCall(1, 1), toolResult(1, 2), assistantMsg(1, 3, { surfaceOp: 'append' }), turnEnd(1, 4),
    turnStart(2, 5),
    ev(6, 'compaction/prune', { turn: 2, shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 5 }),
    toolResult(2, 7, { sourceEventSeqs: [2], surfaceOp: { op: 'replace', start: 2, end: 2 } }),
    turnEnd(2, 8),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1,2'), { turnRules, seqRules })
  // the metering event and the replacement tool/result are both gone
  assert.equal(out.filter(e => e.type === 'compaction/prune').length, 0)
  assert.equal(out.filter(e => e.type === 'tool/result').length, 1) // only the original (seq 2) survives
  assert.doesNotThrow(() => foldSurface(out))
})

test('reIndexEvents: nested skip-till blocks close like brackets', () => {
  const customSeq: SeqReIndexRules = {
    ...seqRules,
    'outer/start': { rules: [{ kind: 'skip-till', till: 'outer/end' }] },
    'inner/start': { rules: [{ kind: 'skip-till', till: 'inner/end' }] },
  }
  const log: SessionEvent[] = [
    turnStart(1, 0),
    ev(1, 'outer/start', { turn: 1 }),
    ev(2, 'inner/start', { turn: 1 }),
    ev(3, 'inner/end', { turn: 1 }),
    ev(4, 'outer/end', { turn: 1 }),
    ev(5, 'after', { turn: 1 }),
    turnEnd(1, 6),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  // the inner block closes before the outer one; everything inside is gone
  assert.equal(out.filter(e => ['outer/start', 'inner/start', 'inner/end', 'outer/end'].includes(e.type)).length, 0)
  // the event after the outer block survives
  assert.ok(out.find(e => e.type === 'after'))
})

test('reIndexEvents: skip-n takes the max when an overlapping run extends it', () => {
  const customSeq: SeqReIndexRules = {
    ...seqRules,
    'a/start': { rules: [{ kind: 'skip-n', n: 1 }] },
    'b/start': { rules: [{ kind: 'skip-n', n: 3 }] },
  }
  const log: SessionEvent[] = [
    turnStart(1, 0),
    ev(1, 'a/start', { turn: 1 }), // skip this + 1
    ev(2, 'b/start', { turn: 1 }), // lands mid-run: extend to this + 3
    ev(3, 'x', { turn: 1 }),
    ev(4, 'x', { turn: 1 }),
    ev(5, 'x', { turn: 1 }),
    ev(6, 'x', { turn: 1 }),
    ev(7, 'x', { turn: 1 }),
    turnEnd(1, 8),
  ]
  const out = reIndexEvents(log, KInterval.from_string('1'), { turnRules, seqRules: customSeq })
  // skipped: a/start, b/start, x3, x4, x5 (b/start extends the run); x6,x7 live
  assert.equal(out.filter(e => e.type === 'x').length, 2)
})
