# dsh-klip

A plugin that clips arbitrary selected turn ranges out of a conversation and merges them into a new session.

> [简体中文](./README.zh.md)

```sh
/klip 1..3,7        # cut turns 1..3 and 7 into one new session
/klip -5.., not -3  # the last 5 turns, minus turn 3
```

klip re-indexes the selected events into a new session and attaches it to the current workspace.

## KInterval syntax

A KInterval is a comma-separated list of clauses, each selecting turns by 1-based index. Negative numbers count from the end (`-1` is the last turn). All intervals are closed.

| Form | Meaning |
|------|---------|
| `x` | turn `x` only |
| `a..b` | turns `a` through `b` |
| `a..` | turn `a` to the last |
| `..b` | first turn through `b` |
| `..` | all turns |
| `not I` | exclude the interval `I` |

Examples:

```sh
/klip 3           # just turn 3
/klip 2..5        # turns 2, 3, 4, 5
/klip 4..         # turn 4 to the last
/klip ..3         # turns 1, 2, 3
/klip ..          # all turns
/klip .., not 2   # all turns except turn 2
/klip -3..        # the last 3 turns
```

Whitespace is ignored, so `1..2` and `1 .. 2` are equivalent.

## Features

- **Automatic re-indexing.** Selected turns are renumbered to a contiguous `1..N` and `SessionEvent.seq` is reset to start from 0.
- **Dangling reference cleanup.** When an event references a cut-away event, it is dropped too, cascading until nothing references a deleted event.
- **Customizable rules.** Re-indexing is driven by the rule tables in `src/rules.ts`; supporting a third-party event type only needs a rule, not engine changes.
- **Automatic naming.** New sessions are named `KLIP <source title>`.

## Customizing rules

Re-indexing is driven by two tables in `src/rules.ts`: `turnRules` remaps `turn` values, and `seqRules` remaps `seq` and translates references between events. To support a third-party event type, add a rule:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...existing user/message, tool/result, ... entries...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // new
}
```

Rebuild (`npm run build`) and restart the profile to apply. Each event type supports three reference-rule shapes:

- **`value`** — a single numeric reference (e.g. `seq`, `data.turn`). The event is dropped if the target is not in the result.
- **`array`** — a numeric array reference (e.g. `sourceEventSeqs`). Dead members are filtered out; the event is dropped only when all members are dead.
- **`interval`** — a closed-interval reference (e.g. `surfaceOp.start` / `surfaceOp.end`). It is intersected with the surviving seq set; the event is dropped only when the intersection is empty.
- **`override: true`** — the type fully takes over its rule and skips the `*` wildcard.

## How it works

`KInterval` (`src/k-interval.ts`) parses the range text into include/exclude intervals; `reIndexEvents` (`src/re-index.ts`) takes the selected events, renumbers them (`seq` contiguous, `turn` dense), and remaps all references, producing a valid session seed.

Notes:

- Only **completed** turns are cut. Header events (those without a `turn` field, before the first turn) are always kept.
- The new session is created through the agent factory, flushed to disk, then attached to the source workspace.

## Project layout

```
dsh-klip/
├── package.json          # package contract: exports, peer deps
├── scripts/build.mjs     # esbuild build
├── src/
│   ├── index.ts          # plugin entry: /klip command, session creation, workspace attach
│   ├── k-interval.ts     # KInterval language (pure)
│   ├── rules.ts          # editable rule tables (default turnRules / seqRules)
│   └── re-index.ts       # pure re-indexing of events into a session seed
└── test/                 # KInterval and re-indexing tests
```

## Verify

```sh
npm run typecheck   # tsc --noEmit
npm run build       # emit lib/index.js, lib/types/
npm test            # run the tests
```

## License

MIT
