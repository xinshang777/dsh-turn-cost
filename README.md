# dsh-turn-cost

DSH Web 界面：在每轮 assistant 回复的时间戳正后方显示**该轮费用金额**，并可显示该轮结束时的**上下文占用百分比**（点击触发 `/compact`）。

## 功能

- 每轮时间戳后注入费用金额（¥，自适应小数位 / 可固定）
- 可选显示上下文占用百分比，点击按钮等价于手打 `/compact`（走官方 command 路径）
- 金额/占用与 dsh 的时间戳**同处一行、共享同一套显隐规则**（见下「可见性」）
- 实时事件 + 历史会话回填（基于 sessionPersistence），落盘于 `~/.dsh/dsh-turn-cost/turns.json`
- 会话归属以官方 `data-conversation-session` 为准：切换/新建会话不会串到别的会话数据
- 适配 dsh 明暗主题（`body[data-ds-dark-theme]`）
- 所有接口带回环 + 同源 + cookie 鉴权护栏

> 计价口径对齐 `dsh-whale-widget@0.3.16`（**独立实现，不依赖该插件安装**）。升级 whale-widget 后若费率有变，请比对 `lib/pricing.mjs` 顶部的 `PEAK_HOURS / BASE_PRICE / ...` 常量。

## 可见性

金额与上下文环挂在每轮的时间戳节点上，**与时间戳自身共享同一套显隐规则**：

- 时间线**最后一轮**：常显
- **其余轮次**：鼠标悬停该轮时才显示

这不是缺陷，而是**刻意对齐 dsh 上游的交互**（dsh 对非末轮的 `.actions` 行统一采用悬停揭示）。如果你确实希望所有轮次都常显，可以自行注入一行 CSS：

```css
[data-actions-reveal=hover]:has([data-dsh-turn-cost]) .xzv4MW_actions{opacity:1}
```

代价是该轮所有操作按钮也会一起常显、与 dsh 行为不一致，因此本插件默认不做这件事。

## 安装

```bash
dsh plugin --profile web add link:.
# 或
dsh plugin --profile web add github:xinshang777/dsh-turn-cost
```

**⚠️ 装完还必须手工补一步**：`dsh plugin add` 只是把包转交给 pnpm，**不会**把插件写进 profile 的 `dsh.profile.bundles`；缺了这一步插件不会激活。编辑 `~/.dsh/profiles/web/package.json`，把它加进已有的数组：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["…原有项…", "dsh-turn-cost"]
    }
  }
}
```

然后重启 `dsh web`。

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
