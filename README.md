<div align="center">

# dsh-turn-cost

**在每一轮 AI 回复后面，直接显示这一轮花了多少钱。**

顺带显示该轮结束时的**上下文占用百分比**，点一下等于帮你执行 `/compact`。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%40deepseek--ai%2Fdsh-7C3AED)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#三安装)

</div>

---

## 先花 30 秒搞懂它是什么

| 名词 | 白话解释 |
|---|---|
| **DSH** | DeepSeek Harness（npm 包 `@deepseek-ai/dsh`），**跑在你自己电脑上**的 AI 工作台，自带网页界面。 |
| **一轮（turn）** | 你发一句话，AI 回一段话，这就是一轮。 |
| **token** | AI 计费的最小单位，可以粗略理解成"字数"。输入、输出都按 token 收费。 |
| **本插件** | 一个 DSH 插件。装上后，**每轮回复的时间戳后面会多出一小段"¥0.0123"**。 |

如果你从没算过自己用 AI 花了多少钱，这个插件就是那把小票打印机。

---

## 一、适用范围（谁该用它）

**适合你，如果：**

- 你**按月/按量计费**，想知道到底哪一轮、哪个会话最烧钱，而不是月底看一个总数；
- 你有**长会话**，隐约感觉"越聊越贵"，想看看上下文涨到什么程度了；
- 你想知道**什么时候提问更便宜**——本插件按官方峰谷价计费，一眼能看出这一轮是不是踩在高峰上；
- 你用 `/compact` 压缩上下文，但总忘了手动敲，想有个按钮点一下就行。

**不适合你，如果：**

- 你用的是**包月/订阅制**、完全不关心单轮开销；
- 你的模型不是 DeepSeek 系，且你也不想手工开"未知模型也计费"的开关（默认对非 DeepSeek 模型**不计价**，会显示为 0）。

---

## 二、它能做什么（通俗版）

装上之后，界面上原来长这样：

```text
助手                                          14:32
已经把那个函数改成异步的了，注意 await 的位置…
```

现在变成这样：

```text
助手                                     28%  ·  ¥0.0123  ·  14:32
已经把那个函数改成异步的了，注意 await 的位置…
                                              ↑ 新增：上下文占用 | 本轮费用
```

三件事一次说清：

| 显示项 | 含义 | 点它能干什么 |
|---|---|---|
| **`28%`** | 这一轮结束时，上下文窗口被占了多少 | 点一下 = 执行 `/compact` 压缩上下文 |
| **`¥0.0123`** | **这一轮**（只算这一轮）的费用 | — |
| **`14:32`** | DSH 原生时间戳（本来就有） | — |

它**不修改 DSH 原本的时间戳**，只是把自己的内容挂在同一个节点上，所以：
外观、位置、显隐规则都与原生时间戳保持一致，明暗主题也会自动适配。

---

## 三、安装

### 前置条件

| 项 | 要求 |
|---|---|
| Node.js | 18 或更高 |
| pnpm | `npm i -g pnpm` |
| DSH | `npm i -g @deepseek-ai/dsh`，装完能跑起 `dsh web` |

### 方式 A：直接从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:xinshang777/dsh-turn-cost
```

### 方式 B：克隆到本地再以链接方式安装（想改代码时用）

```bash
git clone https://github.com/xinshang777/dsh-turn-cost.git
cd dsh-turn-cost
dsh plugin --profile web add link:.
```

### 方式 C：只想下载

仓库页面 → **Code** → **Download ZIP**。

### 安装后必须重启

```bash
# 停掉 dsh web（Ctrl + C），然后
dsh web
```

> 💡 装了 [dsh-restart-button](https://github.com/xinshang777/dsh-restart-button) 的话，点界面上的按钮即可重启。

### 重启后没显示费用？检查这一处

`dsh plugin add` 安装成功后**会自动**把插件登记进 profile 的 `dsh.profile.bundles`，正常无需手动改配置。

若重启后看不到金额，打开 `~/.dsh/profiles/web/package.json`，确认 `dsh.profile.bundles` 数组里有 `dsh-turn-cost`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-turn-cost"          // ← 有这一项才算已挂载
      ]
    }
  }
}
```

没有就手动补上并重启。

---

## 四、使用教程

### 第 1 步：看费用

装完重启、刷新页面，随便问一句。回复下方的时间戳旁就会多出金额。

### 第 2 步：明白"什么时候才可见"

金额与时间戳**共享同一套显隐规则**（这是刻意对齐 DSH 上游的交互，不是 bug）：

| 位置 | 显示时机 |
|---|---|
| 时间线**最后一轮** | 常显 |
| **其余轮次** | 鼠标移到那一轮上时才显示 |

如果你希望**所有轮次都常显**，可以自行注入一行 CSS：

```css
[data-actions-reveal=hover]:has([data-dsh-turn-cost]) .xzv4MW_actions { opacity: 1 }
```

代价是该轮**所有操作按钮也一起常显**，与 DSH 默认行为不一致，所以本插件默认不做。

### 第 3 步：点上下文百分比压缩上下文

点击 `28%` 那个数字 → 插件走**官方 command 路径**触发 `/compact`，等价于你手打 `/compact`。
超时时间默认 120 秒，可通过 `compactTimeoutMs` 调整。

### 第 4 步：历史会话也能看到金额

插件会用 DSH 的 `sessionPersistence` **回填历史会话**：切换回旧会话时，之前的轮次也会显示出金额
（按**事件自身发生的时间**判定峰谷，所以历史数据是稳定、可复现的）。
数据落盘在 `~/.dsh/dsh-turn-cost/turns.json`。

### 第 5 步（可选）：调配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在 `dsh-turn-cost` 的 `config:` 下调整。
**注意是整体替换**：写几个字段就只生效几个字段，其余回落到默认值。

```yaml
- id: dsh-turn-cost
  config:
    currency: "¥"
    decimals: null          # null = 自适应小数位
    showContext: true       # 是否显示上下文占用
    backfill: true          # 是否回填历史会话
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `currency` | `¥` | 货币符号 |
| `decimals` | `null` | 小数位；`null` = 自适应（≥1 显示 2 位 / ≥0.01 显示 3 位 / 其余 4 位） |
| `tinyLabel` | `¥<0.0001` | 小到四位小数仍是 0 时的替代文案 |
| `showContext` | `true` | 是否显示上下文占用百分比 |
| `compactTimeoutMs` | `120000` | 点击触发 `/compact` 的超时（毫秒） |
| `pollMs` / `pollMsHidden` | `1200` / `6000` | 轮询间隔（页面可见 / 页面隐藏） |
| `backfill` | `true` | 是否回填历史会话 |
| `priceUnknownProviders` | `false` | 非 DeepSeek 模型是否也按默认价计费 |
| `includeCacheWrite` | `false` | 是否把 `cacheWriteTokens` 按未命中价计入 |
| `ttlDays` / `maxSessions` / `maxTurnsPerSession` / `maxBytes` | `30` / `200` / `2000` / `4194304` | 持久化上限（过期、条数、字节数） |
| `maxReplayEvents` / `debounceMs` | `50000` / `400` | 单会话回填事件上限 / 落盘去抖 |

---

## 五、实现原理

### 1. 数据从哪来

DSH 运行时会通过 `sessionProjections` / `sessionPersistence` 暴露每一轮 assistant 消息的
**usage**（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）与**模型 / provider**。
插件订阅这些事件，逐条算出费用；页面隐藏时降低轮询频率（`pollMsHidden`）省资源。

### 2. 怎么算钱（计价口径）

计价口径**对齐 `dsh-whale-widget@0.3.15`**（独立实现，不依赖该插件安装）。
单位是**元 / 百万 token**，高峰价为空闲价的 **2 倍**：

| 模型 | 缓存命中（hit） | 未命中输入（miss） | 输出（out） |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.3 | 4.5 / 9 | 13.5 / 27 |

*（每格为 空闲价 / 高峰价）*

**峰谷判定规则**：

- **高峰**：北京时间 周一至周五 的 `09:00–12:00`、`14:00–18:00`（不含法定节假日）；
- **谷时**：周六周日全天、法定节假日全天（内置 2026 年节假日表）、以及工作日的高峰时段之外。

单条消息的费用：

```
费用 = 缓存命中token/1e6 × hit价
     + 未命中输入token/1e6 × miss价
     + 输出token/1e6 × out价
```

几条容易踩的口径说明：

- `reasoningTokens` **包含在** `outputTokens` 里，不重复累加；
- `cacheWriteTokens` **默认不计费**（可用 `includeCacheWrite` 打开）；
- **只对 DeepSeek 系模型计价**（provider 或 model 名含 `deepseek`），避免给第三方模型乱贴钱；
- 与 whale 的一处**有意偏差**：whale 用 `Date.now()` 判峰谷，本插件用**事件自身的时间**——
  实时场景差异可忽略，但历史回填必须如此才准确、可复现。

> ⚠️ 费率常量是**复制**而非 import（whale 没有导出它们）。升级 `dsh-whale-widget` 后，
> 请比对 `lib/pricing.mjs` 顶部的 `PEAK_HOURS / BASE_PRICE / PRO_PRICE / HOLIDAY_VALLEY`。
> 每年国务院发布次年节假日安排后，需要补下一年的 `HOLIDAY_VALLEY`。

### 3. 显示挂在哪

通过 `@deepseek-ai/dsh-client-ui-conversation` 的插槽，把节点**挂到该轮已存在的时间戳节点上**
（而不是自己新建一行）。所以它天然继承了时间戳的显隐规则、对齐方式和主题变量，
会话归属也以官方 `data-conversation-session` 为准——切换或新建会话不会串数据。

### 4. 拦截与安全

所有 HTTP 接口都带回环（loopback）+ 同源（Origin）+ cookie 鉴权护栏，
只允许本地页面调用，避免被跨站页面或 DNS 重绑定利用。

### 5. 目录结构

```text
dsh-turn-cost/
├── lib/
│   ├── index.js       # 宿主侧：订阅 usage 事件、HTTP 接口、轮询与落盘调度
│   ├── pricing.mjs    # 计价：峰谷判定 + 模型价目表 + 单条费用
│   ├── money.mjs      # 金额格式化（自适应小数位 / 极小值文案）
│   ├── ledger.mjs     # 账本：turns.json 读写、TTL / 条数 / 字节上限、去抖落盘
│   └── backfill.mjs   # 历史会话回填
├── assets/client.js   # 浏览器侧：把节点挂到时间戳上、点击触发 /compact
├── cordis.patch.yml   # bundle 挂载声明 + 默认配置
└── package.json
```

---

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 非最后一轮看不到金额 | **预期行为**：非末轮 hover 才显示（对齐 DSH 上游交互）。想常显见上方 CSS 片段。 |
| 金额一直是 `¥0.0000` | ① 该轮模型不是 DeepSeek 系（默认不计价）；② 该轮没有 usage 数据。 |
| 金额和官方账单对不上 | 本插件是**按 token × 价目表估算**，且价目表复制自 whale，官方调价或改峰谷规则后会偏差。请以官方账单为准。 |
| 点百分比没反应 | `/compact` 需要当前会话支持该命令；超时默认 120 秒；先确认手动敲 `/compact` 是正常的。 |
| 历史会话金额显示为零 | 历史数据依赖 DSH 的持久化记录；超出 `ttlDays` / `maxSessions` 上限的旧数据会被回收。 |
| 页面卡顿 | 会话数很多时调小 `maxTurnsPerSession` / `maxBytes`，或调大 `pollMs`。 |

---

## License

[MIT](LICENSE)
