// User-editable rule tables for klip's re-indexing engine. Edit this file to
// adapt klip to third-party event types, then rebuild and restart the profile.
//
// - turnRules: which field carries the turn number (wildcard → `data.turn`).
// - seqRules : which fields reference other events' seqs (wildcard → `seq`).
//   Reference invalidation cascades: an event with all-dead references is
//   dropped, and anything that then points at it is dropped in turn.
//
// The two tables have SEPARATE rule types. turnRules renumbers a turn
// reference (`value`/`array`/`interval`); seqRules owns the seq reference shapes
// plus the structural skip rules.
//
// Rule shapes; a missing/mistyped field → skipped (kept); a present-but-fully
// dead value → dropped (unless `keep`):
//   - value    : single numeric ref. Not in map → drop.
//   - array    : numeric array ref. All dead → drop; some dead → filter.
//   - interval : closed [start,end]. No overlap with survivors → drop; else
//     re-project. With `surface: true` (seq table only) it re-projects onto the
//     surface-only map — used by a `surfaceOp.start/end` replacement.
//   - skip-n   : drop this event and the next `n` events — a fixed-length run,
//     used for a prune ([compaction/prune, tool/result replacement], n=1).
//   - skip-till: drop events until one of type `till` appears (inclusive);
//     a stack (bracket matching) supports nesting — used to remove a whole
//     compaction (`compaction/start` → till `compaction/end`), records and the
//     summarizing checkpoint together.
//
// Optional presence flag on `array`: `keep: true` turns an all-dead reference
// from "drop the event" into "keep the event with the array emptied to `[]`".
// `value`/`interval` have no `keep` — a hard reference still sinks the event
// when its target is gone.
//
// `seqSurface` is a SEPARATE table (not a cell flag): it lists the EVENT TYPES
// that join the model-visible surface — message-producing nodes that the surface
// fold keeps (user/message, assistant/message, tool/result). A type in that list
// is added to the surface-only seq map. An `interval` rule with `surface: true`
// uses that map; every other reference (`value`/`array`/`interval`) re-projects
// onto ALL survivors — e.g. `sourceEventSeqs` → a plain `tool/call` record.
//
// Cell-level flag (a sibling of the rule array):
//   - `override`: the type's own rules fully replace the wildcard; absent
//     (not `true`) means they extend it.
// `false` is never written; absent means false.
//
// Maps driving the renumbering:
//   - turnMap       : oldTurn → newTurn (1..N), selected turns only.
//   - seqMap        : oldSeq → newSeq (0..N-1), filled in one forward scan; refs
//                     point only at earlier seqs, so targets are already in the map.
//   - surfaceSeqMap : oldSeq → newSeq for the `seqSurface` types only.

// Turn table: renumbers turn references (single, array, or a closed turn range).
export type TurnRule =
  | { kind: 'value'; path: string }
  | { kind: 'array'; path: string; keep?: true }
  | { kind: 'interval'; startPath: string; endPath: string }
export interface TurnTypeRules {
  override?: true
  rules?: readonly TurnRule[]
}

// Seq table: renumbers seq references and drops structural blocks.
export type SeqRule =
  | { kind: 'value'; path: string }
  | { kind: 'array'; path: string; keep?: true }
  | { kind: 'interval'; startPath: string; endPath: string; surface?: true }
  | { kind: 'skip-n'; n: number }
  | { kind: 'skip-till'; till: string }
export interface SeqTypeRules {
  override?: true
  rules?: readonly SeqRule[]
}

export type TurnReIndexRules = Readonly<Record<string, TurnTypeRules>>
export type SeqReIndexRules = Readonly<Record<string, SeqTypeRules>>

// Event types that join the model-visible surface — message-producing nodes the
// surface fold keeps. A type listed here is added to the surface-only seq map.
export const seqSurface: readonly string[] = [
  'user/message',
  'assistant/message',
  'tool/result',
]

export const turnRules: TurnReIndexRules = {
  '*': { rules: [{ kind: 'value', path: 'data.turn' }] },
}

export const seqRules: SeqReIndexRules = {
  '*': { rules: [{ kind: 'value', path: 'seq' }] },
  'user/message': {
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end', surface: true },
    ],
  },
  'assistant/message': {
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end', surface: true },
    ],
  },
  'tool/result': {
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end', surface: true },
    ],
  },
  // command/done is the tail that closes a command/run's "still executing" state
  // in the UI. Its sourceEventSeq is a display-only soft reference to an earlier
  // domain event (e.g. compaction/summary) — it must never sink the event, or a
  // surviving command/run renders as calling forever. So it gets NO reference
  // rule: the wildcard remaps its own seq and the event always survives.
  'command/done': {},
  'session/title': { rules: [{ kind: 'array', path: 'data.messageSeqs' }] },
  // Parent-only compaction is one whole block: skip it entirely so its
  // checkpoint (a replace user/message) never leaks a compression effect into
  // the seed. compaction/summary sits inside the start..till block and needs no
  // rule; compaction/end is the skip-till closer (matched by type, no rule). A
  // prune is a fixed pair — [compaction/prune, tool/result replacement] — so
  // skip-n (n=1) drops both with no end marker.
  'compaction/start': { rules: [{ kind: 'skip-till', till: 'compaction/end' }] },
  'compaction/prune': { rules: [{ kind: 'skip-n', n: 1 }] },
}
