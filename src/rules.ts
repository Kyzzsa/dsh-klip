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
// dead value → dropped:
//   - value            : single numeric ref. Not in map → drop.
//   - array            : numeric array ref. All dead → drop; some dead → filter.
//   - interval         : closed [start,end] re-projected onto ALL survivors.
//   - surface-interval : closed [start,end] re-projected onto the surface-only
//     map (see `seqSurface` below). Used by a `surfaceOp.start/end` replacement.
//   - skip-n           : drop this event and the next `n` events — a fixed-length
//     run, used for a prune ([compaction/prune, tool/result replacement], n=1).
//   - skip-till        : drop events until one of type `till` appears (inclusive);
//     a stack (bracket matching) supports nesting — used to remove a whole
//     compaction (`compaction/start` → till `compaction/end`), records and the
//     summarizing checkpoint together.
//
// `seqSurface` is a SEPARATE table (not a cell flag): it lists the EVENT TYPES
// that join the model-visible surface — message-producing nodes that the surface
// fold keeps (user/message, assistant/message, tool/result). A type in that list
// is added to the surface-only seq map. A `surface-interval` rule uses that map;
// every other reference (`value`/`array`/`interval`) re-projects onto ALL
// survivors — e.g. `sourceEventSeqs` → a plain `tool/call` record.
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
  | { kind: 'array'; path: string }
  | { kind: 'interval'; startPath: string; endPath: string }
export interface TurnTypeRules {
  override?: true
  rules: readonly TurnRule[]
}

// Seq table: renumbers seq references and drops structural blocks.
export type SeqRule =
  | { kind: 'value'; path: string }
  | { kind: 'array'; path: string }
  | { kind: 'interval'; startPath: string; endPath: string }
  | { kind: 'surface-interval'; startPath: string; endPath: string }
  | { kind: 'skip-n'; n: number }
  | { kind: 'skip-till'; till: string }
export interface SeqTypeRules {
  override?: true
  rules: readonly SeqRule[]
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
      { kind: 'surface-interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
    ],
  },
  'assistant/message': {
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'surface-interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
    ],
  },
  'tool/result': {
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'surface-interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
    ],
  },
  'command/done': { rules: [{ kind: 'value', path: 'data.sourceEventSeq' }] },
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
