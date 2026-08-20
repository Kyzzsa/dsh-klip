# dsh-klip

一个 `/klip` 命令,把会话里选中的 turn 区间剪切出来,合并成一条全新会话。

> [English](./README.md)

```sh
/klip 1..3,7        # 剪切 turn 1..3 和 7,合成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,去掉 turn 3
```

用极简的 **KInterval** 语法(1 基 turn 号)圈定范围,klip 会把选区重排成一条新会话、自动挂回你所在的 workspace,完事——不用再做任何手工配置。

## 它能帮你做什么

- **自动重排。** 选中的 `turn` 被重排为稠密的 `1..N`,`SessionEvent.seq` 被重写为从 `0` 连续递增,新会话开箱即用。
- **删除失效引用,并连它一起删。** 任何指向被裁事件的引用都会删除该事件——而**指向这个被删事件**的引用也会被一并删除,逐级向下级联,直到没有任何东西再指向被删事件为止。
- **规则可自定义。** 重排由规则表驱动(`src/rules.ts`):为第三方事件类型追加规则,rebuild、重启即可,无需改动引擎。
- **新会话自动命名 `KLIP <原标题>`**,一眼就能和源会话区分开。

## 自定义规则

重排由 `src/rules.ts` 里的两张表驱动(`turnRules` 重映射 turn、`seqRules` 重映射 seq 并翻译引用)。给某个事件类型加一条规则即可适配第三方插件,不用碰引擎:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...已有的 user/message、tool/result 等条目...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // 新增
}
```

改完 `npm run build` 并重启 profile 生效。每种事件类型可声明三类引用规则:

- **`value`** — 单个数值引用(如 `seq`、`data.turn`):目标不在映射里 → 删除该事件。
- **`array`** — 数值数组引用(如 `sourceEventSeqs`):过滤掉失效成员,仅当全部失效才删除。
- **`interval`** — 闭区间引用(如 `surfaceOp.start` / `surfaceOp.end`):与幸存的 seq 集合求交,交集为空才删除。
- **`override: true`** — 让该类型完全接管,跳过通配符 `*` 规则(仅对具体类型有效)。

## 工作原理(有兴趣再看)

- **KInterval**(`src/k-interval.ts`)把范围文本解析为 include/exclude 区间。
- **reIndexEvents**(`src/re-index.ts`)提取选区并重写为合法会话种子:`seq` 连续、`turn` 稠密、所有事件内引用跟随重映射。
- 只剪切**已完成**的 turn;头部事件(无 `turn` 字段、位于第一个 turn 之前)始终保留。
- 新会话通过 agent 工厂创建(因此可持久化、可在 UI 中打开),flush 落盘后挂回源 workspace。

## 项目结构

```
dsh-klip/
├── package.json          # 包契约:exports、peer deps
├── scripts/build.mjs     # esbuild 构建
├── src/
│   ├── index.ts          # 插件入口:/klip 命令、会话创建、workspace 挂载
│   ├── k-interval.ts     # KInterval 语言(纯函数)
│   ├── rules.ts          # 用户可编辑的规则表(默认 turnRules / seqRules)
│   └── re-index.ts       # 纯重排:事件重写为会话种子
└── test/                 # KInterval 与重排测试
```

## 验证

```sh
npm run typecheck   # tsc --noEmit
npm run build       # 产出 lib/index.js、lib/types/
npm test            # 运行测试
```

## License

MIT
