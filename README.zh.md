# dsh-klip

把对话里想要的部分剪出来,拼成一条全新的会话。

> [English](./README.md)

```sh
/klip 1..3,7        # 剪出 turn 1..3 和 turn 7,合并成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,去掉 turn 3
```

用一套很简单的 **KInterval** 语法(按 turn 编号,从 1 开始)圈定范围,klip 会把选中的部分重排成一条新会话、自动挂回你当前的 workspace——剪完即用,不用再手动做任何事。

## 它能做什么

- **自动重排。** 选中的 `turn` 会变成连续的 `1..N`,`SessionEvent.seq` 也会从 `0` 重新编下去,新会话开箱即用,不会留空洞。
- **悬空引用会级联清除。** 裁掉某些事件后,任何引用到它们的事件都会被连带删掉;删掉的事件如果又被别的引用,也会继续跟着删,直到没有事件再指向任何被删的事件为止。
- **规则可扩展。** 重排逻辑由规则表驱动(`src/rules.ts`)。想适配第三方插件的事件类型,加一条规则就行,不用改引擎。
- **新会话自动命名 `KLIP <原标题>`**,一眼就能和源会话区分开。

## 自定义规则

重排由 `src/rules.ts` 里的两张表驱动:`turnRules` 负责重映射 turn,`seqRules` 负责重映射 seq 并翻译事件之间的引用。想适配某个第三方事件类型,加一条规则即可,完全不用碰引擎:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...已有的 user/message、tool/result 等条目...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // 新增
}
```

改完 `npm run build` 再重启 profile 就生效。每种事件类型可以声明三种引用规则:

- **`value`** — 单个数值引用(如 `seq`、`data.turn`):指向的事件不在裁剪结果里,就删掉这个事件。
- **`array`** — 数值数组引用(如 `sourceEventSeqs`):把失效的成员过滤掉,只有全部成员都失效才删。
- **`interval`** — 闭区间引用(如 `surfaceOp.start` / `surfaceOp.end`):和幸存的 seq 集合求交集,交集为空才删。
- **`override: true`** — 让该类型完全接管自己的规则,跳过通配符 `*`(只对具体类型有意义)。

## 原理(想了解再读)

- **KInterval**(`src/k-interval.ts`)把范围文本解析成 include/exclude 区间。
- **reIndexEvents**(`src/re-index.ts`)取出选中部分,重写为一份合法的会话种子:`seq` 连续、`turn` 稠密、所有事件内引用都跟着重映射。
- 只剪**已完成**的 turn;头部事件(没有 `turn` 字段、位于第一个 turn 之前)始终保留。
- 新会话经由 agent 工厂创建(所以能持久化、能在 UI 里打开),flush 落盘后再挂回源 workspace。

## 项目结构

```
dsh-klip/
├── package.json          # 包契约:exports、peer deps
├── scripts/build.mjs     # esbuild 构建
├── src/
│   ├── index.ts          # 插件入口:/klip 命令、会话创建、workspace 挂载
│   ├── k-interval.ts     # KInterval 语法(纯函数)
│   ├── rules.ts          # 规则表(默认 turnRules / seqRules,可自行编辑)
│   └── re-index.ts       # 纯重排:把事件重写为会话种子
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
