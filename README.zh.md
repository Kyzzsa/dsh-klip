# dsh-klip

一个把会话中选中的任意 turn 区间裁切、合并成一条新会话的插件。

> [English](./README.md)

```sh
/klip 1..3,7        # 剪出 turn 1..3 和 turn 7,合并成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,去掉 turn 3
```

klip 把选中的事件重排成一条新会话,并挂载到当前 workspace。

## KInterval 语法

KInterval 是逗号分隔的子句,每段按 turn 编号(从 1 开始)选择;负数从末尾数起(`-1` 是最后一个 turn)。所有区间都是闭区间。

| 写法 | 含义 |
|------|------|
| `x` | 只选 turn `x` |
| `a..b` | 选 turn `a` 到 `b` |
| `a..` | 选 turn `a` 到末尾 |
| `..b` | 选开头到 turn `b` |
| `..` | 全选 |
| `not I` | 排除区间 `I` |

示例:

```sh
/klip 3           # 只选 turn 3
/klip 2..5        # 选 turn 2、3、4、5
/klip 4..         # 选 turn 4 到末尾
/klip ..3         # 选 turn 1、2、3
/klip ..          # 全选
/klip .., not 2   # 全选,但排除 turn 2
/klip -3..        # 最后 3 个 turn
```

空白会被忽略,`1..2` 与 `1 .. 2` 等价。

## 功能

- **自动重排。** 选中的 turn 重编号为连续的 `1..N`,`SessionEvent.seq` 从 0 重新开始。
- **失效引用清理。** 引用了被裁掉事件的该事件也会被删除,并级联直到没有事件引用已删除事件。
- **规则可自定义。** 重排由 `src/rules.ts` 的规则表驱动;支持第三方事件类型只需加规则,无需改引擎。
- **自动命名。** 新会话命名为 `KLIP <原标题>`。

## 自定义规则

重排由 `src/rules.ts` 的两张表驱动:`turnRules` 重映射 turn,`seqRules` 重映射 seq 并翻译事件间的引用。每种事件类型映射到一个**单元格** — 一个 `rules` 数组,外加一个可选的 presence 标志:

- **`override: true`** — 该类型的规则完全取代通配符 `*`(缺省表示在其基础上扩展)。

两张表使用**各自独立的规则类型**。`turnRules` 重编号 turn 引用(`value` / `array` / `interval`);`seqRules` 负责 seq 引用以及结构性的跳过规则。`seqRules` 的规则:

- **`value`** — 单个数值引用(如 `seq`)。目标不在结果中则删除该事件。
- **`array`** — 数值数组引用(如 `sourceEventSeqs`)。过滤失效成员,仅当全部成员失效才删除。
- **`interval`** — 闭区间引用(如 `surfaceOp.start` / `surfaceOp.end`)。与**全部**幸存的 seq 集合求交集,为空才删除。
- **`surface-interval`** — 闭区间引用,但投影到 **surface-only** seq map(见下方 `seqSurface`)。`surfaceOp.start` / `surfaceOp.end` 用的就是它。
- **`skip-n`** — 删除该事件及其后 `n` 个事件(固定长度),用于删除一对 prune。
- **`skip-till`** — 一直删除直到出现类型为 `till` 的事件(含该事件);用括号匹配栈实现,因此跳过块可以嵌套。

**surface 不再作为单元格或规则的标志**,而是独立成一张表 `seqSurface`,列出加入模型可见 surface 的事件类型(即产出消息、会被 surface fold 保留的节点)。列在该表里的类型会被加入 surface-only seq map;`surface-interval` 规则使用这张 map,而其它所有引用(`value` / `array` / `interval`)都投影到**全部**幸存者。普通引用如 `sourceEventSeqs`(指向 `tool/call` 等普通记录)用的是 `interval` / `array`,恰恰是为了不被限制到 surface。

支持第三方事件类型就加一个单元格(如果它产出消息,同时把它列进 `seqSurface`):

```ts
// src/rules.ts
export const seqSurface = ['user/message', 'assistant/message', 'tool/result']

export const seqRules: SeqReIndexRules = {
  '*': { rules: [{ kind: 'value', path: 'seq' }] },
  // ...已有的 user/message、tool/result 等条目...
  'my/plugin/event': {
    rules: [{ kind: 'value', path: 'data.parentSeq' }], // 新增
  },
}
```

改完执行 `npm run build` 并重启 profile。

## 原理

`KInterval`(`src/k-interval.ts`)把范围文本解析为 include/exclude 区间;`reIndexEvents`(`src/re-index.ts`)取出选中的事件、重编号(seq 连续、turn 稠密)并重映射所有引用,生成合法的会话种子。

注意事项:

- 只剪切**已完成**的 turn;头部事件(第一个 turn 之前、无 `turn` 字段)始终保留。
- 新会话通过 agent 工厂创建,先写入磁盘,再挂载到源 workspace。

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
