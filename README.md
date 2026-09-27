# dsh-turn-cost

DSH Web 界面：在每轮 assistant 回复的时间戳正后方显示**该轮费用金额**，并可显示该轮结束时的**上下文占用百分比**（点击触发 `/compact`）。

## 功能

- 每轮时间戳后注入费用金额（¥，自适应小数位 / 可固定）
- 可选显示上下文占用百分比，点击按钮等价于手打 `/compact`（走官方 command 路径）
- 实时事件 + 历史会话回填（基于 sessionPersistence），落盘于 `~/.dsh/dsh-turn-cost/turns.json`
- 所有接口带回环 + 同源 + cookie 鉴权护栏

> 计价口径对齐 `dsh-whale-widget@0.3.15`（**独立实现，不依赖该插件安装**）。升级 whale-widget 后若费率有变，请比对 `lib/pricing.mjs` 顶部的 `PEAK_HOURS / BASE_PRICE / ...` 常量。

## 安装

```bash
dsh plugin --profile web add link:.
# 或
dsh plugin --profile web add github:<你的用户名>/dsh-turn-cost
```

安装后重启 `dsh web`。

## 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在 `dsh-turn-cost` 的 `config:` 下可调整（**整体替换**）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `currency` | `¥` | 货币符号 |
| `decimals` | `null` | 小数位；`null`=自适应（≥1 两位 / ≥0.01 三位 / 其余四位） |
| `tinyLabel` | `¥<0.0001` | 极小金额显示文案 |
| `pollMs` / `pollMsHidden` | `1200` / `6000` | 轮询间隔（页面可见 / 隐藏） |
| `showContext` | `true` | 是否显示上下文占用 |
| `compactTimeoutMs` | `120000` | 触发 `/compact` 的超时 |
| `backfill` | `true` | 是否回填历史会话 |
| `ttlDays` / `maxSessions` / `maxTurnsPerSession` / `maxBytes` | `30` / `200` / `2000` / `4194304` | 持久化上限 |

## 兼容性

- 需要 `webServer` 及 `agents` / `commands` / `sessionProjections` / `sessionPersistence` / `connection` 服务（web profile 自带）
- 零运行时依赖

## License

MIT
