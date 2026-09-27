// 计价口径对齐来源： node_modules/dsh-whale-widget/lib/index.js:446-537
// （核对版本：dsh-whale-widget@0.3.15）
//
// ⚠️ 这是**复制**而非 import —— whale 没有导出这些常量。
//    升级 dsh-whale-widget 后，请 grep 比对下面的 PEAK_HOURS / BASE_PRICE /
//    PRO_PRICE / HOLIDAY_VALLEY 是否与新版一致。
// ⚠️ 每年 11 月国务院发布次年节假日安排后，必须补下一年的 HOLIDAY_VALLEY 日期。

export const PRICING_SOURCE = 'dsh-whale-widget@0.3.15:lib/index.js:446-537'

// 高峰时段（官方说明）：北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

// DeepSeek CNY 单价（元 / 百万 token）：[空闲时段价, 高峰时段价]
// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）
export const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro 为 Flash 的 3 倍价
export const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

export const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}

// 北京时间 2026-08-23 00:00 起，周末全天按谷价
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
// 北京时间 2026-09-19 00:00 起，法定节假日全天按谷价
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)

// 只需列**放假**的日期；调休上班日全部落在周末，按"周末也算谷价"本就是谷价，无需单列。
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,                 // 元旦 1/1–1/3
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1,                 // 春节 2/15–2/23（9 天）
  '2026-02-18': 1, '2026-02-19': 1, '2026-02-20': 1,
  '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,                 // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1,                 // 劳动节 5/1–5/5
  '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,                 // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,                 // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1,                 // 国庆 10/1–10/7
  '2026-10-04': 1, '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

function isHolidayValley(bjDate) {
  try {
    return !!HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)]
  } catch {
    return false
  }
}

/**
 * 峰谷判定。与 whale 同规则：周末 → 谷；法定节假日 → 谷；再按北京小时判 9-12 / 14-18。
 * @param {number} timeSec epoch 秒
 */
export function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000) // 按 UTC 读即为北京日历日
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/** 模型价目查找：子串匹配，键长降序优先，未命中走 _default */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  const keys = Object.keys(PRICING)
    .filter((k) => k !== '_default')
    .sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

/**
 * 是否应对这条 message 计价。
 * whale 没有这道门禁（它对任何模型都走 _default），那会给第三方模型乱贴钱。
 * 这里默认只对 DeepSeek 系计价。
 */
export function shouldPrice(source, priceUnknownProviders) {
  if (priceUnknownProviders) return true
  const p = String(source?.provider || '')
  const m = String(source?.model || '')
  return /deepseek/i.test(p) || /deepseek/i.test(m)
}

/**
 * 单条 assistant/message 的费用。
 * 口径（与 whale 一致）：
 *   - cacheReadTokens  → hit 价
 *   - inputTokens      → miss 价
 *   - outputTokens     → out 价（reasoningTokens ⊆ outputTokens，不重复累加）
 *   - cacheWriteTokens → 默认不计入
 *
 * 与 whale 的一处有意偏差：whale 用 Date.now() 判峰谷，这里用**事件自身的 time**。
 * 实时场景差异可忽略；历史回填必须用事件时间，统一口径更准且可复现。
 */
export function costOf(usage, source, atMs, opts = {}) {
  const input = Number(usage?.inputTokens) || 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const cacheW = Number(usage?.cacheWriteTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const includeWrite = !!opts.includeCacheWrite
  const tokens = input + cache + output + (includeWrite ? cacheW : 0)

  if (!shouldPrice(source, opts.priceUnknownProviders)) {
    return { cost: 0, tokens, priced: false, peak: false, model: source?.model || '' }
  }

  const p = priceFor(source?.model)
  const off = isPeakTime(Math.floor(Number(atMs || Date.now()) / 1000)) ? 1 : 0
  const cost =
    (cache / 1e6) * p.hit[off] +
    ((input + (includeWrite ? cacheW : 0)) / 1e6) * p.miss[off] +
    (output / 1e6) * p.out[off]

  return { cost, tokens, priced: true, peak: !!off, model: source?.model || '' }
}
