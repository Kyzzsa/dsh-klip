import type { SessionEvent } from '@deepseek-ai/dsh-session'
import dlv from 'dlv'
import { dset } from 'dset'
import { KInterval } from './k-interval.ts'
import type { ReIndexRules, SeqReIndexRules } from './rules.ts'

// Node 22 has structuredClone; declared here because the project has no
// DOM/@types/node types.
declare const structuredClone: <T>(value: T) => T

// Extract the KInterval-selected turns and renumber them into a seed that
// agents.create accepts. seq → contiguous from 0, turn → dense 1..N, step
// restarts at 1. Events with all-dead references are dropped; reference
// invalidation propagates. Pure: never mutates arguments (deep-copies because
// session events are frozen).
// @param rules - caller passes { turnRules, seqRules } from ./rules.ts.
export function reIndexEvents(
  events: readonly SessionEvent[],
  kInterval: KInterval,
  rules: { turnRules: ReIndexRules; seqRules: SeqReIndexRules },
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
  // the surface nodes — types whose seqRules carry a `surface: true` interval.
  // A surface interval re-projects onto the latter: the surface fold keeps only
  // those in its node list, so landing on a non-surface survivor replays as
  // "start seq N not found in surface".
  const seqMap = new Map<number, number>()
  const surfaceSeqMap = new Map<number, number>()

  const reIndexedEvents: SessionEvent[] = []
  let turn = 0 // 0 = before the first turn → header events kept unconditionally
  let newSeq = 0

  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (!(turn === 0 || turnMap.has(turn))) continue

    seqMap.set(event.seq, newSeq)
    // A surface event is one whose seqRules declare a surface interval; all its
    // seq refs (own seq, sourceEventSeqs, surfaceOp range) are surface nodes, so
    // the whole event resolves against surfaceSeqMap. Surface handling lives
    // here, in the map choice; applyRules stays single-map.
    const isSurface = (rules.seqRules[event.type] ?? []).some(rule => 'surface' in rule)
    if (isSurface) surfaceSeqMap.set(event.seq, newSeq)

    const reIndexed = structuredClone(event)

    if (applyRules(reIndexed, rules.seqRules, isSurface ? surfaceSeqMap : seqMap)
      && applyRules(reIndexed, rules.turnRules, turnMap)) {
      reIndexedEvents.push(reIndexed)
      newSeq++
    } else {
      seqMap.delete(event.seq)
      surfaceSeqMap.delete(event.seq)
    }
  }

  return reIndexedEvents
}

function applyRules(
  event: SessionEvent,
  rules: ReIndexRules,
  map: Map<number, number>,
): boolean {
  const specificRule = rules[event.type] ?? []
  const hasOverride = specificRule.some(rule => rule.override === true)
  const rulesToApply = hasOverride ? specificRule : [...(rules['*'] ?? []), ...specificRule]
  for (const rule of rulesToApply) {
    if (rule.kind === 'value') {
      if (!applyValue(event, rule.path, map)) return false
    } else if (rule.kind === 'array') {
      if (!applyArray(event, rule.path, map)) return false
    } else {
      if (!applyInterval(event, rule.startPath, rule.endPath, map)) return false
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
