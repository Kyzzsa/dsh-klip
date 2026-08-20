# dsh-klip

A single `/klip` command cuts turn ranges out of a conversation and merges them into a brand-new session.

> [简体中文](./README.zh.md)

```sh
/klip 1..3,7        # cut turns 1..3 and 7 into one new session
/klip -5.., not -3  # the last 5 turns, minus turn 3
```

Pick ranges with the tiny **KInterval** syntax (1-based turns). klip re-indexes the selection into a fresh session and hooks it back into your workspace — no manual steps, nothing else to configure.

## Install

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add /path/to/dsh-klip
# then restart that profile
```

## What it does for you

- **Re-indexes automatically.** Selected `turn`s become a dense `1..N` and `SessionEvent.seq` becomes contiguous from `0`, so the new session is immediately usable.
- **Drops dead references, and anything that points at them.** A reference to a cut-away event drops that event — and any event referencing *that* dropped event is dropped too, cascading down the chain until nothing points at a deleted event.
- **Customizable rules.** The re-indexing is rule-driven (`src/rules.ts`): add rules for third-party event types, rebuild, restart — no engine changes.
- **Auto-titled `KLIP <source title>`.** The new session is named so you can tell it apart from the source at a glance.

## Customizing rules

The re-indexing is driven by two tables in `src/rules.ts` (`turnRules` remaps `turn`, `seqRules` remaps `seq` and translates references). Add a rule for an event type to adapt a third-party plugin without touching the engine:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...existing user/message, tool/result, ... entries...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // new
}
```

Rebuild (`npm run build`) and restart the profile. Each event type can declare three reference-rule shapes:

- **`value`** — a single numeric reference (e.g. `seq`, `data.turn`): target not in the map → the event is dropped.
- **`array`** — a numeric array reference (e.g. `sourceEventSeqs`): dead members are filtered out; the event drops only when all are dead.
- **`interval`** — a closed-interval reference (e.g. `surfaceOp.start` / `surfaceOp.end`): intersected with the surviving seq set; dropped only when the intersection is empty.
- **`override: true`** — fully takes over that type, skipping the `*` wildcard (only meaningful on a concrete type).

## How it works — read on only if you care

- **KInterval** (`src/k-interval.ts`) parses the range text into include/exclude intervals.
- **reIndexEvents** (`src/re-index.ts`) extracts the selection and rewrites it into a valid session seed: contiguous `seq`, dense `turn`, every intra-event reference remapped.
- Only **completed** turns are cut; header events (no `turn` field, before the first turn) are always kept.
- The new session is created through the agent factory (so it persists and opens in the UI), flushed, then attached to the source workspace.

## Project layout

```
dsh-klip/
├── package.json          # package contract: exports, peer deps
├── scripts/build.mjs     # esbuild build
├── src/
│   ├── index.ts          # plugin entry: /klip command, session creation, workspace attach
│   ├── k-interval.ts     # KInterval language (pure)
│   ├── rules.ts          # user-editable rule tables (default turnRules / seqRules)
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
