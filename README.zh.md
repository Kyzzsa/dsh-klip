# dsh-klip

一个把会话中选中的 turn 区间剪切出来、合并成一条新会话的插件。

> [English](./README.md)

```sh
/klip 1..3,7        # 剪出 turn 1..3 和 turn 7,合并成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,去掉 turn 3
```

用 KInterval 语法(按 turn 编号,从 1 开始)指定范围。klip 会把选中的事件重排成一条新会话,并挂回当前 workspace。

## 功能

- **自动重排。** 选中的 turn 被重编号为连续的 `1..N`,`SessionEvent.seq` 从 0 重新开始,新会话可直接使用。
- **失效引用清理。** 某事件引用了被裁掉的事件时,该事件也会被删除,并继续级联,直到没有任何事件引用已删除的事件。
- **规则可自定义。** 重排由 `src/rules.ts` 中的规则表驱动。要支持第三方事件类型,加一条规则即可,无需改动引擎。
- **自动命名。** 新会话命名为 `KLIP <原标题>`,以便与源会话区分。

## 自定义规则

重排由 `src/rules.ts` 中的两张表驱动:`turnRules` 重映射 turn,`seqRules` 重映射 seq 并翻译事件之间的引用。要支持第三方事件类型,添加一条规则:

```ts
// src/rules.ts
export const seqRules: ReIndexRules = {
  '*': [{ kind: 'value', path: 'seq' }],
  // ...已有的 user/message、tool/result 等条目...
  'my/plugin/event': [{ kind: 'value', path: 'data.parentSeq' }], // 新增
}
```

修改后执行 `npm run build` 并重启 profile 生效。每种事件类型支持三种引用规则:

- **`value`** — 单个数值引用(如 `seq`、`data.turn`)。目标不在结果中时,删除该事件。
- **`array`** — 数值数组引用(如 `sourceEventSeqs`)。过滤掉失效成员,仅当全部成员失效时才删除。
- **`interval`** — 闭区间引用(如 `surfaceOp.start` / `surfaceOp.end`)。与幸存的 seq 集合求交集,交集为空时才删除。
- **`override: true`** — 该类型完全接管自己的规则,跳过通配符 `*`。仅对具体类型有意义。

## 原理

`KInterval`(`src/k-interval.ts`)把范围文本解析为 include/exclude 区间。`reIndexEvents`(`src/re-index.ts`)取出选中的事件,重新编号(`seq` 连续、`turn` 稠密),并重映射所有引用,生成合法的会话种子。

注意事项:

- 只剪切**已完成**的 turn;头部事件(没有 `turn` 字段、位于第一个 turn 之前)始终保留。
- 新会话通过 agent 工厂创建,因此可持久化并能在 UI 中打开;先 flush 落盘,再挂回源 workspace。

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
