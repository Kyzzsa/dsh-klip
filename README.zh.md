# dsh-klip

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) host 插件,提供全局 `/klip` 命令。它从当前会话里提取一组选定的 turn 区间,合并成一条全新的会话,使用 **KInterval** 迷你语言(`1..3,7`、`-5.., not -3`)。

> [English README](./README.md)

---

## 它能做什么

- 注册全局 `/klip` 命令(`src/index.ts`)。
- 参数是一个 **KInterval**(`src/k-interval.ts`):把 1 基的 turn 号解析为 include/exclude 区间,再根据已完成的 turn 总数实例化为具体区间。
- 通过 `reIndexEvents`(`src/re-index.ts`)把选中的 turn 区间重排成一条合法的会话种子。
- 用 `ctx.agents.create` 创建新会话,`ctx.sessions.flush` 持久化,并在源会话所属 workspace 存在时把它挂回该 workspace。

示例:

```
/klip 1..3,7        # 提取 turn 1..3 和 7,合成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,减去 turn 3
```

### 核心特性

- **自动重映射 turn 与 `SessionEvent.seq` 区间,并链式删除失效引用。** 选中区间的 `turn` 被重排为稠密的 `1..N`,`seq` 被重写为从 `0` 连续递增,所有事件内的引用(`sourceEventSeqs`、`surfaceOp` 替换边界、`command/done.sourceEventSeq`、`session/title.messageSeqs`)都跟随重映射;任何指向被裁掉事件的引用都会使该事件被删除,并且这种失效会**链式传播**下去——一旦有事件因为引用失效被删,引用它的事件也随之被删。
- **可高度自定义的 rules。** 重排逻辑由一张规则表驱动(见 `src/rules.ts`),每种事件类型都可以声明 value / array / interval 三种引用形状,还支持 `override` 完全接管某类型。你可以直接在 `src/rules.ts` 里为第三方插件的事件类型追加规则,改完 `npm run build` 重启即可生效,无需改动重排引擎本身。

### 设计要点

- **只提取已完成的 turn。** turn 数量由 `turn/end` 事件推导,因此在进行的 turn(只有 `turn/start`、没有配对 `turn/end`)永远不会被包含——这与 DSH 自身 fork 会话的方式一致。
- **头部事件被保留。** 不带 `turn` 字段、出现在第一个 `turn/start` 之前的事件(如 `permission/preset`、`sandbox/mode`、`approval/policy`)会被无条件保留,因此重排后的会话仍保有环境事实。
- **指向被裁事件的引用被删除。** `value` 引用无法解析时删除该事件;`array` 引用过滤掉已死的成员、仅当全部成员都死时才删除;`interval`(替换边界)与幸存的 seq 集合求交、交集为空时删除。
- 新会话通过 agent 工厂创建,因为普通会话无法被持久化、在 UI 中打开或被驱动;`flush` 让缓冲的事件落盘。

## 安装 / 使用

把本目录作为 bundle 添加到一个 profile(按你的配置改 profile 名):

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add /path/to/dsh-klip
# 然后重启该 profile
```

构建产物已经在 `lib/`(`npm run build`)。改代码后重新 `npm run build` 并重启 profile 即可生效。

## 项目结构

```
dsh-klip/
├── package.json          # 包契约:exports、peer deps
├── tsconfig.json         # 类型检查 + lib/types/*.d.ts 产物
├── scripts/build.mjs     # host 侧的 esbuild 构建
├── src/
│   ├── index.ts          # 插件入口:/klip 命令、会话创建、workspace 挂载
│   ├── k-interval.ts     # KInterval 语言(纯函数:from_string + instantiate)
│   ├── rules.ts          # 用户可编辑的规则表(默认 turnRules / seqRules)
│   └── re-index.ts       # 纯重排:把事件重排为会话种子
└── test/
    ├── k-interval.test.ts  # KInterval 解析/实例化测试
    └── re-index.test.ts    # 重排与引用重写测试
```

### 核心概念

- **KInterval**(`src/k-interval.ts`):把文本解析为原始 include/exclude 端点,再由 `instantiate(len)` 针对 `[1, len]` 解析成具体的闭区间。1 基索引。
- **重排**(`src/re-index.ts`):提取选中的 turn 区间,重写为 `agents.create` 接受的种子。驱动约束来自 `dsh-session`:种子的 `seq` 必须从 `0` 连续;每个 `sourceEventSeqs` / `surfaceOp` 替换边界 / `command/done.sourceEventSeq` 都必须引用一个更早、且幸存的的事件。引用指向被裁事件的事件会被删除;被覆盖节点全部被裁的 `replace` 事件整体删除。
- **规则**(`src/rules.ts`):默认的 `turnRules` / `seqRules`,是重排引擎的用户定制面。

### 包契约

- `exports["."]` → host 侧 `lib/index.js`。
- `peerDependencies` 声明运行时服务包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-workspace`),由宿主 profile 提供。

## 验证

```sh
npm run typecheck   # tsc --noEmit
npm run build       # 产出 lib/index.js、lib/types/
npm run verify      # 检查 host bundle 形状
npm test            # 运行 KInterval 与重排测试
```

## License

MIT
