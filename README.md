# dsh-klip

Cut the parts of a conversation you want and merge them into a brand-new session.

> [简体中文](./README.zh.md)

```sh
/klip 1..3,7        # cut turns 1..3 and 7 into one new session
/klip -5.., not -3  # the last 5 turns, minus turn 3
```

Pick your ranges with the small **KInterval** syntax (1-based turn numbers), and klip re-indexes the selection into a fresh session that's automatically hooked back into your current workspace — no manual steps, nothing else to configure.

## What it does for you

- **Re-indexes automatically.** Selected `turn`s become a dense `1..N` and `SessionEvent.seq` runs contiguously from `0`, so the new session is immediately usable, with no gaps left behind.
- **Cascades dangling-reference cleanup.** When an event references a cut-away event, that event is dropped too — and if another event references *that* dropped one, it drops as well, cascading outward until nothing points at a deleted event.
- **Rules are extensible.** Re-indexing is rule-driven (`src/rules.ts`). To adapt a third-party plugin's event types, add a rule — no engine changes needed.
- **Auto-titles the new session `KLIP <source title>`** so you can tell it apart from the source at a glance.

## Customizing rules

Re-indexing is driven by two tables in `src/rules.ts`: `turnRules` remaps `turn`, and `seqRules` remaps `seq` and translates inter-event references. To adapt a third-party event type, add a single rule without touching the engine:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...existing user/message, tool/result, ... entries...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // new
}
```

Rebuild (`npm run build`) and restart the profile to apply. Each event type can declare three reference-rule shapes:

- **`value`** — a single numeric reference (e.g. `seq`, `data.turn`): if the target isn't in the result, the event is dropped.
- **`array`** — a numeric array reference (e.g. `sourceEventSeqs`): dead members are filtered out; the event drops only when all members are dead.
- **`interval`** — a closed-interval reference (e.g. `surfaceOp.start` / `surfaceOp.end`): intersected with the surviving seq set; dropped only when the intersection is empty.
- **`override: true`** — lets the type fully take over its rule, skipping the `*` wildcard (only meaningful on a concrete type).

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
