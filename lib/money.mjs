// 定点金额运算，与 dsh-whale-widget/lib/accounting.mjs 同方案（SCALE = 1e8）。
// 避免浮点累加误差在多轮累计后放大。

const SCALE = 100000000

export function moneyUnits(v) {
  const u = Math.round(Number(v) * SCALE)
  if (!Number.isSafeInteger(u)) return 0
  return u
}

export function preciseMoney(v) {
  return moneyUnits(v) / SCALE
}

export function addMoney(a, b) {
  return preciseMoney(a + b)
}
