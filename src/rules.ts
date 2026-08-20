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
// See the top of ./re-index.ts for the full rule semantics.
import type { ReIndexRules } from './re-index.ts'

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
