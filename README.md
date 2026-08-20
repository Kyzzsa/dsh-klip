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
