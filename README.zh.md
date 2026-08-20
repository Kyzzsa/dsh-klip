# dsh-klip

一个 `/klip` 命令,把会话里选中的 turn 区间剪切出来,合并成一条全新会话。

> [English](./README.md)

```sh
/klip 1..3,7        # 剪切 turn 1..3 和 7,合成一条新会话
/klip -5.., not -3  # 最近 5 个 turn,去掉 turn 3
```

用极简的 **KInterval** 语法(1 基 turn 号)圈定范围,klip 会把选区重排成一条新会话、自动挂回你所在的 workspace,完事——不用再做任何手工配置。

## 安装

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add /path/to/dsh-klip
# 然后重启该 profile
```

## 它能帮你做什么

- **自动重排。** 选中的 `turn` 被重排为稠密的 `1..N`,`SessionEvent.seq` 被重写为从 `0` 连续递增,新会话开箱即用。
- **删除失效引用,并连它一起删。** 任何指向被裁事件的引用都会删除该事件——而**指向这个被删事件**的引用也会被一并删除,逐级向下级联,直到没有任何东西再指向被删事件为止。
- **规则可自定义。** 重排由规则表驱动(`src/rules.ts`):为第三方事件类型追加规则,rebuild、重启即可,无需改动引擎。

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
