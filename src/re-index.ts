import type { SessionEvent } from '@deepseek-ai/dsh-session'
import dlv from 'dlv'
import { dset } from 'dset'
import { KInterval } from './k-interval.ts'
import type { ReIndexRule, ReIndexRules, SeqReIndexRules } from './rules.ts'

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
  // the surface nodes. Whether an event joins the surface is a property of its
  // type (`seqRules[type].surface`), so a surface event's refs — including its
  // surfaceOp range — all re-project onto surfaceSeqMap: the surface fold keeps
  // only those in its node list, so landing on a non-surface survivor would
  // replay as "start seq N not found in surface".
  const seqMap = new Map<number, number>()
  const surfaceSeqMap = new Map<number, number>()

  const reIndexedEvents: SessionEvent[] = []
  let turn = 0 // 0 = before the first turn → header events kept unconditionally
  let newSeq = 0

  // Skip state, one check. `skip-n` drops this event plus the next `n` (a
  // countdown that takes the max when overlapping); `skip-till` drops until an
  // event of a named type appears (a stack, bracket-matching, so blocks nest).
  // The current event's own markers are honored even while skipping — being
  // inside a skip does NOT invalidate the marker we're about to read. Entering
  // a new turn clears both, so an unmatched skip can't hide the next turn.
  let skipCount = 0
  const skipStack: string[] = []

  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      skipCount = 0
      skipStack.length = 0
    }
    if (!(turn === 0 || turnMap.has(turn))) continue

    // Inline wildcard+override merge for both tables (seq first, reused below).
    const seqCell = rules.seqRules[event.type]
    const seqRuleSet = seqCell?.override === true
      ? seqCell.rules
      : [...(rules.seqRules['*']?.rules ?? []), ...(seqCell?.rules ?? [])]

    // Update skip state from this event's markers before deciding to skip it.
    const skipN = seqRuleSet.find(rule => rule.kind === 'skip-n')
    if (skipN !== undefined) skipCount = Math.max(skipCount, skipN.n + 1)
    const skipTill = seqRuleSet.find(rule => rule.kind === 'skip-till')
    if (skipTill !== undefined) skipStack.push(skipTill.till)

    // Is this event inside a skip? Evaluated once, before consuming it. A
    // countdown run drops this event and the next `n`; a skip-till block drops
    // every event in it, including the closer that closes the block.
    let skip = false
    if (skipCount > 0) { skipCount--; skip = true }
    if (skipStack.length > 0) {
      skip = true
      if (event.type === skipStack[skipStack.length - 1]) skipStack.pop()
    }

    if (skip) continue

    seqMap.set(event.seq, newSeq)
    const isSurface = rules.seqRules[event.type]?.surface ?? false
    if (isSurface) surfaceSeqMap.set(event.seq, newSeq)

    const reIndexed = structuredClone(event)

    const turnCell = rules.turnRules[event.type]
    const turnRuleSet = turnCell?.override === true
      ? turnCell.rules
      : [...(rules.turnRules['*']?.rules ?? []), ...(turnCell?.rules ?? [])]

    if (applyRules(reIndexed, seqRuleSet, isSurface ? surfaceSeqMap : seqMap)
      && applyRules(reIndexed, turnRuleSet, turnMap)) {
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
  rules: readonly ReIndexRule[],
  map: Map<number, number>,
): boolean {
  for (const rule of rules) {
    if (rule.kind === 'value') {
      if (!applyValue(event, rule.path, map)) return false
    } else if (rule.kind === 'array') {
      if (!applyArray(event, rule.path, map)) return false
    } else if (rule.kind === 'interval') {
      if (!applyInterval(event, rule.startPath, rule.endPath, map)) return false
    }
    // skip-n and skip-till carry no refs; the scan loop handles them.
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
