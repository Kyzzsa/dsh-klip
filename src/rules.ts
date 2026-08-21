// User-editable rule tables for klip's re-indexing engine. Edit this file to
// adapt klip to third-party event types, then rebuild and restart the profile.
//
// - turnRules: which field carries the turn number (wildcard → `data.turn`).
// - seqRules : which fields reference other events' seqs (wildcard → `seq`).
//   Reference invalidation cascades: an event with all-dead references is
//   dropped, and anything that then points at it is dropped in turn.
//
// Each rule is one of five shapes; a missing/mistyped field → skipped (kept);
// a present-but-fully-dead value → dropped:
//   - value      : single numeric ref. Not in map → drop.
//   - array      : numeric array ref. All dead → drop; some dead → filter.
//   - interval   : closed [start,end]. No overlap with survivors → drop; else re-project.
//   - skip-n     : drop this event and the next `n` events — a fixed-length run,
//     used for a prune ([compaction/prune, tool/result replacement], n=1).
//   - skip-till  : drop events until one of type `till` appears (inclusive); a
//     stack (bracket matching) supports nesting — used to remove a whole
//     compaction (`compaction/start` → till `compaction/end`), records and the
//     summarizing checkpoint together.
//
// The table is keyed per event type; each value is a CELL that carries how that
// type is handled. Type-level flags (a sibling of the rule array, never a
// per-rule flag):
//   - `override` : the type's own rules fully replace the wildcard; absent
//     (not `true`) means they extend it.
//   - `surface`  (seq table only) : the type joins the model-visible surface, so
//     its refs re-project onto surface nodes only. Both default to false when
//     undefined. turnRules never needs `surface`.
//
// Maps driving the renumbering:
//   - turnMap: oldTurn → newTurn (1..N), selected turns only.
//   - seqMap : oldSeq → newSeq (0..N-1), filled in one forward scan; refs point
//              only at earlier seqs, so targets are already in the map.

// Base rule: turn fields and ordinary seq references. No surface, no override.
export type ReIndexRule =
  | { kind: 'value'; path: string }
  | { kind: 'array'; path: string }
  | { kind: 'interval'; startPath: string; endPath: string }
  | { kind: 'skip-n'; n: number }
  | { kind: 'skip-till'; till: string }

// A type cell common to both tables: `override` plus the rule array.
export interface RuleCell {
  override?: true
  rules: readonly ReIndexRule[]
}

// A seq table cell: adds whether the type joins the surface. Both flags default
// to false when undefined.
export interface SeqTypeRules extends RuleCell {
  surface?: boolean
}

export type ReIndexRules = Readonly<Record<string, RuleCell>>
export type SeqReIndexRules = Readonly<Record<string, SeqTypeRules>>

export const turnRules: ReIndexRules = {
  '*': { rules: [{ kind: 'value', path: 'data.turn' }] },
}

export const seqRules: SeqReIndexRules = {
  '*': { rules: [{ kind: 'value', path: 'seq' }] },
  'user/message': {
    surface: true,
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
    ],
  },
  'assistant/message': {
    surface: true,
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
    ],
  },
  'tool/result': {
    surface: true,
    rules: [
      { kind: 'array', path: 'sourceEventSeqs' },
      { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
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
