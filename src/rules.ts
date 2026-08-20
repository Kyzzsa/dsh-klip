// User-editable rule tables for klip's re-indexing engine.
//
// Edit this file to adapt klip to third-party event types, then re-run
// `npm run build` and restart the profile. The types come from ./re-index.ts;
// this module stays pure data so it is trivial to extend.
//
// - turnRules: which field carries the turn number. Only rules that reference
//   a turn field matter here; the wildcard remaps `data.turn`.
// - seqRules : which fields carry references to other events' seq numbers.
//   The wildcard remaps `seq` itself; per-type rules rewrite reference fields.
//   Reference invalidation cascades: an event whose references are all dead is
//   dropped, and anything that then points at it is dropped in turn.
//
// Session-event re-indexing: extract the selected turn ranges and renumber them
// into a fresh seed.
//
// The rule table (ReIndexRules) declares, per event type (or '*'), the reference
// fields each rule handles. Every field is one of three shapes with a uniform
// semantic: a missing/mistyped field → skipped (the rule does not apply to the
// event, the wildcard no-ops), the event is kept; a present-but-fully-dead value
// → the event is dropped:
//   - value   : a single numeric reference. Not in the map → drop.
//   - array   : a numeric array reference. All members dead → drop; some dead → filter.
//   - interval: a closed [start,end]. No overlap with the surviving set → drop;
//               overlapping → re-project both ends.
// `override` is meaningful only on a concrete-type rule: when a type has any
// override rule, the wildcard is skipped entirely and only its own rules apply
// (that type is fully taken over). `override` on a wildcard rule is meaningless
// and ignored.
//
// Two maps drive the renumbering:
//   - turnMap: oldTurn → newTurn (1..N), covering only the selected turns.
//   - seqMap : oldSeq → newSeq (0..N-1), filled in a single forward scan.
//              Because references point only at earlier seqs, a reference's
//              target is already in the map by the time the event is processed.

export type { ReIndexRule, ReIndexRules }

type ReIndexRule =
  | { kind: 'value'; path: string; override?: true }                    // single numeric reference
  | { kind: 'array'; path: string; override?: true }                    // numeric array reference
  | { kind: 'interval'; startPath: string; endPath: string; override?: true }  // closed interval reference

type ReIndexRules = Readonly<Record<string, readonly ReIndexRule[]>>

// Remap the turn number carried on every event inside a turn.
export const turnRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'data.turn' }],
}

// Rewrite `seq` to be contiguous from 0 and translate every intra-event
// reference so it points at the surviving, renumbered events.
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  'user/message': [
    { kind: 'array', path: 'sourceEventSeqs' },
    { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
  ],
  'assistant/message': [
    { kind: 'array', path: 'sourceEventSeqs' },
    { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
  ],
  'tool/result': [
    { kind: 'array', path: 'sourceEventSeqs' },
    { kind: 'interval', startPath: 'surfaceOp.start', endPath: 'surfaceOp.end' },
  ],
  'command/done': [{ kind: 'value', path: 'data.sourceEventSeq' }],
  'session/title': [{ kind: 'array', path: 'data.messageSeqs' }],
}
