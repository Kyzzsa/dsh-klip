import type { SessionEvent } from '@deepseek-ai/dsh-session'
import dlv from 'dlv'
import { dset } from 'dset'
import { KInterval } from './k-interval.ts'
import { seqSurface } from './rules.ts'
import type { SeqReIndexRules, SeqRule, TurnReIndexRules, TurnRule } from './rules.ts'

// Node 22 has structuredClone; declared here because the project has no
// DOM/@types/node types.
declare const structuredClone: <T>(value: T) => T

// Skip state carried through the forward scan.
interface SkipState {
  count: number // skip-n countdown, indexed by the ORIGINAL seq
  stack: string[] // open skip-till blocks (bracket-matched closers)
}

// Extract the KInterval-selected turns and renumber them into a seed that
// agents.create accepts. seq → contiguous from 0, turn → dense 1..N, step
// restarts at 1. Events with all-dead references are dropped; reference
// invalidation propagates. Pure: never mutates arguments (deep-copies because
// session events are frozen).
// @param rules - caller passes { turnRules, seqRules } from ./rules.ts.
export function reIndexEvents(
  events: readonly SessionEvent[],
  kInterval: KInterval,
  rules: { turnRules: TurnReIndexRules; seqRules: SeqReIndexRules },
): SessionEvent[] {
  // Only completed turns (turn/end) are selectable; that event also fixes the
  // turn count the KInterval is instantiated against. No completed turn →
  // nothing to select. There is deliberately NO scan cut-off at this event:
  // trailing records (tool calls, /compact summaries) still belong to their
  // turn and are filtered purely by membership, so they are kept, not dropped.
  const lastTurnEnd = events.findLast(e => e.type === 'turn/end')
  if (lastTurnEnd === undefined) return []
  const turnCount = lastTurnEnd.data.turn

  const intervals = kInterval.instantiate(turnCount)

  const turnMap = new Map<number, number>()
  let newTurn = 1
  for (const interval of intervals) {
    for (let oldTurn = interval.s; oldTurn <= interval.e; oldTurn++) {
      turnMap.set(oldTurn, newTurn++)
    }
  }

  // Two forward seq maps. `seqMap` covers every survivor; `surfaceSeqMap` only
  // the surface nodes (the event types listed in `seqSurface`). A rule re-projects
  // onto `seqMap` unless it is a `surface-interval` (e.g. a surfaceOp range),
  // which re-projects onto `surfaceSeqMap` — the surface fold keeps only message
  // nodes, so landing on a non-surface survivor would replay as "start seq N not
  // found in surface". Normal refs like `sourceEventSeqs` point at plain records
  // (tool/call, chunks) and must use `seqMap` or they would be wrongly dropped.
  const seqMap = new Map<number, number>()
  const surfaceSeqMap = new Map<number, number>()

  const reIndexedEvents: SessionEvent[] = []
  let turn = 0 // 0 = before the first turn → header events kept unconditionally
  let newSeq = 0

  // Skip state for the forward scan. The countdown is indexed by the ORIGINAL
  // (pre-renumber) seq, so it advances over EVERY old event — selected or not —
  // which is why the skip logic runs before the turn-membership check. The
  // stack holds the open skip-till blocks (bracket-matched closers). Entering a
  // new turn clears both so an unmatched skip can't hide the next turn.
  const skipState: SkipState = { count: 0, stack: [] }

  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      skipState.count = 0
      skipState.stack.length = 0
    }

    // Inline wildcard+override merge for both tables (seq first, reused below).
    const seqCell = rules.seqRules[event.type]
    const seqRuleSet = seqCell?.override === true
      ? seqCell.rules
      : [...(rules.seqRules['*']?.rules ?? []), ...(seqCell?.rules ?? [])]

    // Advance the skip state on arrival (old-seq indexed, so it moves over every
    // event regardless of selection), then honor this event's markers. Being
    // inside a skip does NOT invalidate the marker we are about to read.
    if (skipState.count > 0) skipState.count--
    const skipN = seqRuleSet.find(rule => rule.kind === 'skip-n')
    if (skipN !== undefined) skipState.count = Math.max(skipState.count, skipN.n + 1)
    const skipTill = seqRuleSet.find(rule => rule.kind === 'skip-till')
    if (skipTill !== undefined) skipState.stack.push(skipTill.till)

    // Drop while inside a run or an open block (a skip-till closer is popped and
    // dropped here too). Only then the turn-membership check drops unselected
    // events (no renumber) — this must come AFTER the skip advance so the
    // old-seq countdown is not stalled by events in cut-away turns.
    if (skipState.count > 0) continue
    if (skipState.stack.length > 0) {
      if (event.type === skipState.stack[skipState.stack.length - 1]) skipState.stack.pop()
      continue
    }
    if (!(turn === 0 || turnMap.has(turn))) continue

    seqMap.set(event.seq, newSeq)
    if (seqSurface.includes(event.type)) surfaceSeqMap.set(event.seq, newSeq)

    const reIndexed = structuredClone(event)

    const turnCell = rules.turnRules[event.type]
    const turnRuleSet = turnCell?.override === true
      ? turnCell.rules
      : [...(rules.turnRules['*']?.rules ?? []), ...(turnCell?.rules ?? [])]

    if (applySeqRules(reIndexed, seqRuleSet, seqMap, surfaceSeqMap)
      && applyTurnRules(reIndexed, turnRuleSet, turnMap)) {
      reIndexedEvents.push(reIndexed)
      newSeq++
    } else {
      seqMap.delete(event.seq)
      surfaceSeqMap.delete(event.seq)
    }
  }

  return reIndexedEvents
}


// Apply the turn rules: renumber the event's turn reference(s) against
// `turnMap`. `skip-n`/`skip-till` never appear in turn rules (they carry no
// refs and the scan loop handles them).
function applyTurnRules(
  event: SessionEvent,
  rules: readonly TurnRule[],
  turnMap: Map<number, number>,
): boolean {
  for (const rule of rules) {
    if (rule.kind === 'value') {
      if (!applyValue(event, rule.path, turnMap)) return false
    } else if (rule.kind === 'array') {
      if (!applyArray(event, rule.path, turnMap)) return false
    } else if (rule.kind === 'interval') {
      if (!applyInterval(event, rule.startPath, rule.endPath, turnMap)) return false
    }
  }
  return true
}

// Apply the seq rules: renumber the event's seq references. `value`/`array`/
// `interval` use the all-survivor `seqMap`; a `surface-interval` uses the
// surface-only `surfaceSeqMap`. `skip-n`/`skip-till` carry no refs and are
// handled by the scan loop.
function applySeqRules(
  event: SessionEvent,
  rules: readonly SeqRule[],
  seqMap: Map<number, number>,
  surfaceSeqMap: Map<number, number>,
): boolean {
  for (const rule of rules) {
    if (rule.kind === 'value') {
      if (!applyValue(event, rule.path, seqMap)) return false
    } else if (rule.kind === 'array') {
      if (!applyArray(event, rule.path, seqMap)) return false
    } else if (rule.kind === 'interval') {
      if (!applyInterval(event, rule.startPath, rule.endPath, seqMap)) return false
    } else if (rule.kind === 'surface-interval') {
      if (!applyInterval(event, rule.startPath, rule.endPath, surfaceSeqMap)) return false
    }
  }
  return true
}

function applyValue(event: SessionEvent, path: string, map: Map<number, number>): boolean {
  const ref = dlv(event, path)
  if (typeof ref !== 'number') return true

  const mapped = map.get(ref)
  if (mapped === undefined) return false

  dset(event, path, mapped)
  return true
}

function applyArray(event: SessionEvent, path: string, map: Map<number, number>): boolean {
  const ref = dlv(event, path)
  if (!Array.isArray(ref)) return true

  const mapped = ref.map(v => map.get(v)).filter((v): v is number => v !== undefined)
  if (mapped.length === 0) return false

  dset(event, path, mapped)
  return true
}

// Re-project a closed [start,end] range onto surviving candidates in `map`.
function applyInterval(
  event: SessionEvent,
  startPath: string,
  endPath: string,
  map: Map<number, number>,
): boolean {
  const start = dlv(event, startPath)
  const end = dlv(event, endPath)
  if (typeof start !== 'number' || typeof end !== 'number') return true

  let firstOverlapped: number | undefined
  for (let i = start; i <= end; i++) {
    const m = map.get(i)
    if (m !== undefined) {
      firstOverlapped = m
      break
    }
  }
  let lastOverlapped: number | undefined
  for (let i = end; i >= start; i--) {
    const m = map.get(i)
    if (m !== undefined) {
      lastOverlapped = m
      break
    }
  }
  if (firstOverlapped === undefined || lastOverlapped === undefined) return false

  dset(event, startPath, firstOverlapped)
  dset(event, endPath, lastOverlapped)
  return true
}
