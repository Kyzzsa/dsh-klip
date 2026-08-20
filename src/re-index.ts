import type { SessionEvent } from '@deepseek-ai/dsh-session'
import dlv from 'dlv'
import { dset } from 'dset'
import { KInterval } from './k-interval.ts'

// Node 22 provides structuredClone, but the project lib has no DOM/@types/node
// types, so it is declared here.
declare const structuredClone: <T>(value: T) => T

import type { ReIndexRules } from './rules.ts'

// The default rule tables live in ./rules.ts, a standalone module users can
// edit to adapt klip to third-party event types without touching the
// re-indexing engine.

// Extract the KInterval-selected turns from the session event log and renumber
// them into a seed that agents.create accepts.
// - seq is rewritten to be contiguous from 0 (via seqRules, incl. reference translation).
// - turn is rewritten to a dense 1..N (via turnRules).
// - step restarts at 1 each turn; no rewrite needed.
// - Events whose references are all dead (value/array/interval) are dropped.
// - Reference invalidation propagates.
// Pure: does not mutate its arguments. It deep-copies events internally because
// Session events and their data are frozen immutable objects, and renumbering
// needs writable copies.
// @param rules - the rule set. The caller must pass { turnRules, seqRules }
//                explicitly so it can be injected from config; the defaults
//                live in ./rules.ts.
export function reIndexEvents(
  events: readonly SessionEvent[],
  kInterval: KInterval,
  rules: { turnRules: ReIndexRules; seqRules: ReIndexRules },
): SessionEvent[] {
  // Count only completed turns (turn/end); an in-progress turn is not counted,
  // so the KInterval cannot select it. The last completed turn's end is also
  // the scan cut-off: everything after it is the open turn klip is running in.
  const lastTurnEnd = events.findLast(e => e.type === 'turn/end')
  const turnCount = lastTurnEnd?.data.turn ?? 0
  const intervals = kInterval.instantiate(turnCount)

  const turnMap = new Map<number, number>()
  let newTurn = 1
  for (const interval of intervals) {
    for (let oldTurn = interval.s; oldTurn <= interval.e; oldTurn++) {
      turnMap.set(oldTurn, newTurn++)
    }
  }

  const seqMap = new Map<number, number>()
  const reIndexedEvents: SessionEvent[] = []
  let turn = 0 // turns are 1-based; 0 means "before the first turn", so these header events are kept unconditionally
  let newSeq = 0

  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (!(turn === 0 || turnMap.has(turn))) continue

    seqMap.set(event.seq, newSeq)
    const reIndexed = structuredClone(event)
    if (applyRules(reIndexed, rules.seqRules, seqMap) && applyRules(reIndexed, rules.turnRules, turnMap)) {
      reIndexedEvents.push(reIndexed)
      newSeq++
    } else {
      seqMap.delete(event.seq)
    }

    // Stop at the last completed turn's end: everything after it belongs to the
    // open turn /klip runs in, which the KInterval can never select. Placed
    // after the emit so a selected final turn keeps its closing turn/end.
    // Matching by the last turn/end's seq (not the turn number) is intentional:
    // a turn may carry an earlier turn/end while more of its events follow.
    if (event.seq === lastTurnEnd?.seq) break
  }

  return reIndexedEvents
}

function applyRules(event: SessionEvent, rules: ReIndexRules, map: Map<number, number>): boolean {
  const specificRule = rules[event.type] ?? []
  const hasOverride = specificRule.some(rule => rule.override === true)
  const rulesToApply = hasOverride ? specificRule : [...(rules['*'] ?? []), ...specificRule]
  for (const rule of rulesToApply) {
    let ok: boolean
    if (rule.kind === 'value') {
      ok = applyValue(event, rule.path, map)
    } else if (rule.kind === 'array') {
      ok = applyArray(event, rule.path, map)
    } else {
      ok = applyInterval(event, rule.startPath, rule.endPath, map)
    }
    if (!ok) return false
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
