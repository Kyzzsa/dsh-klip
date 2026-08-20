# dsh-klip

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host plugin that adds a global `/klip` command. It extracts a chosen set of turn ranges from the current session and merges them into a brand-new session, using the **KInterval** mini-language (`1..3,7`, `-5.., not -3`).

> [简体中文](./README.zh.md)

---

## What it does

- Registers the global `/klip` command (`src/index.ts`).
- The argument is a **KInterval** (`src/k-interval.ts`): 1-based turn numbers parsed into include/exclude intervals, then instantiated against the total completed-turn count.
- Re-indexes the selected turn ranges into a valid session seed via `reIndexEvents` (`src/re-index.ts`): it rewrites `seq` to be contiguous from `0`, remaps `turn` to a dense `1..N`, and rewrites every intra-event reference (`sourceEventSeqs`, `surfaceOp` replace bounds, `command/done.sourceEventSeq`, `session/title.messageSeqs`) to follow the remapping.
- Creates the new session with `ctx.agents.create`, flushes it with `ctx.sessions.flush`, and attaches it back to the source session's workspace when one exists.

Examples:

```
/klip 1..3,7        # extract turns 1..3 and 7 into one new session
/klip -5.., not -3  # the last 5 turns minus turn 3
```

### Key features

- **Automatically remaps the `turn` and `SessionEvent.seq` ranges and cascade-deletes dead references.** The selected turns are renumbered to a dense `1..N`, `seq` is rewritten to be contiguous from `0`, and every intra-event reference (`sourceEventSeqs`, `surfaceOp` replace bounds, `command/done.sourceEventSeq`, `session/title.messageSeqs`) follows the remapping; any reference that points at a cut-away event drops that event, and the invalidation **cascades** — when an event is dropped for dead references, events that reference it are dropped in turn.
- **Highly customizable rules.** The re-indexing is driven by a rule table (see `src/rules.ts`) in which each event type declares `value` / `array` / `interval` reference shapes, with `override` to fully take over a type. You can append rules for third-party event types directly in `src/rules.ts`, rebuild, and restart — no changes to the engine itself.

### Design notes

- **Only completed turns are extracted.** The turn count is derived from `turn/end` events, so an in-progress turn (a `turn/start` without a matching `turn/end`) is never included — matching how DSH itself forks a session.
- **Header events are preserved.** Events that carry no `turn` field and appear before the first `turn/start` (e.g. `permission/preset`, `sandbox/mode`, `approval/policy`) are kept unconditionally, so a reindexed session keeps its environment facts.
- **References to cut-away events are dropped.** A `value` reference that no longer resolves drops its event; an `array` reference filters out dead members and drops the event only when all members are dead; an `interval` (replace bounds) is intersected with the surviving seq set and dropped when the intersection is empty. This is what the `reIndexEvents` rule table expresses.
- The new session is created through the agent factory because a plain session cannot be persisted, opened in the UI, or driven; `flush` makes the buffered events durable.

## Installation / usage

Add this directory as a bundle to a profile (adjust the profile name to your setup):

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add /path/to/dsh-klip
# then restart that profile
```

Build artifacts already live in `lib/` (`npm run build`). After changing code, re-run `npm run build` and restart the profile to pick up the changes.

## Project layout

```
dsh-klip/
├── package.json          # package contract: exports, peer deps
├── tsconfig.json         # type checking + lib/types/*.d.ts emission
├── scripts/build.mjs     # esbuild build of the host half
├── src/
│   ├── index.ts          # plugin entry: /klip command, session creation, workspace attach
│   ├── k-interval.ts     # KInterval language (pure: from_string + instantiate)
│   ├── rules.ts          # user-editable rule tables (default turnRules / seqRules)
│   └── re-index.ts       # pure re-indexing of events into a session seed
└── test/
    ├── k-interval.test.ts  # KInterval parse/instantiate tests
    └── re-index.test.ts    # re-indexing and reference-rewrite tests
```

### Core concepts

- **KInterval** (`src/k-interval.ts`): parses text into raw include/exclude endpoints, then `instantiate(len)` resolves them into concrete closed intervals against `[1, len]`. 1-based indexing.
- **Re-indexing** (`src/re-index.ts`): extracts the selected turn ranges and rewrites them into a seed that `agents.create` accepts. The driving constraints come from `dsh-session`: seed `seq` must be contiguous from `0`; every `sourceEventSeqs` / `surfaceOp` replace bounds / `command/done.sourceEventSeq` must reference an earlier surviving event. References that point at cut-away events are dropped; a `replace` event whose covered nodes are all cut is dropped entirely.
- **Rules** (`src/rules.ts`): the default `turnRules` / `seqRules` — the user-facing customization surface of the engine.

### Package contract

- `exports["."]` → host half `lib/index.js`.
- `peerDependencies` declare the runtime service packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-workspace`), provided by the hosting profile.

## Verification

```sh
npm run typecheck   # tsc --noEmit
npm run build       # emit lib/index.js, lib/types/
npm run verify      # check the host bundle shape
npm test            # run the KInterval and re-indexing tests
```

## License

MIT
