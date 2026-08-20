// User-editable rule tables for klip's re-indexing engine. Edit this file to
// adapt klip to third-party event types, then rebuild and restart the profile.
//
// - turnRules: which field carries the turn number (wildcard → `data.turn`).
// - seqRules : which fields reference other events' seqs (wildcard → `seq`).
//   Reference invalidation cascades: an event with all-dead references is
//   dropped, and anything that then points at it is dropped in turn.
//
// Each rule is one of three shapes; a missing/mistyped field → skipped (kept);
// a present-but-fully-dead value → dropped:
//   - value   : single numeric ref. Not in map → drop.
//   - array   : numeric array ref. All dead → drop; some dead → filter.
//   - interval: closed [start,end]. No overlap with survivors → drop; else re-project.
// `override` (concrete types only) skips the wildcard entirely.
//
// Maps driving the renumbering:
//   - turnMap: oldTurn → newTurn (1..N), selected turns only.
//   - seqMap : oldSeq → newSeq (0..N-1), filled in one forward scan; refs point
//              only at earlier seqs, so targets are already in the map.

export type { ReIndexRule, ReIndexRules }

type ReIndexRule =
  | { kind: 'value'; path: string; override?: true }
  | { kind: 'array'; path: string; override?: true }
  | { kind: 'interval'; startPath: string; endPath: string; override?: true }

type ReIndexRules = Readonly<Record<string, readonly ReIndexRule[]>>

export const turnRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'data.turn' }],
}

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
