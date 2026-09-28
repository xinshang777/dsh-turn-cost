import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { preciseMoney, addMoney } from './money.mjs'
import { costOf } from './pricing.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function defaultFile() {
  return path.join(DSH_HOME, 'dsh-turn-cost', 'turns.json')
}

/**
 * 按 (sessionId, turn) 聚合每轮费用，去抖落盘到 JSON。
 * 所有失败都 fail-open：坏文件改名后空状态启动，写失败只 warn，不影响 dsh 运行。
 */
export function createLedger(cfg, logger, opts = {}) {
  const warn = (msg) => {
    try {
      logger?.warn?.(msg)
    } catch {}
  }

  // 上下文压力探针：由宿主注入，返回 { used, total, ratio } 或 null。
  // 只在 live 轮次调用 —— 回填无法还原"那一轮结束时"的占用，记了会误导。
  const pressureOf = typeof opts.pressure === 'function' ? opts.pressure : null

  const state = { version: 1, updatedAt: null, sessions: {} }
  const liveAggs = new Map() // sessionId -> { turn, amount, tokens, models:Set, hasPriced, peak, lastTs }
  const observed = new Set() // 本进程内实时观察过的 sessionId

  /* ---------------- 落盘 ---------------- */

  let filePath = defaultFile()
  load()

  let dirty = false
  let timer = null
  let queue = Promise.resolve()

  function pruneIfNeeded() {
    const ttlMs = Number(cfg.ttlDays || 30) * 86400000
    const maxSessions = Number(cfg.maxSessions || 200)
    const maxTurns = Number(cfg.maxTurnsPerSession || 2000)
    const maxBytes = Number(cfg.maxBytes || 4194304)

    let ids = Object.keys(state.sessions)

    // 1) TTL
    if (ttlMs > 0) {
      const cutoff = Date.now() - ttlMs
      for (const id of ids) {
        const s = state.sessions[id]
        if (!s || (s.lastTs || 0) < cutoff) delete state.sessions[id]
      }
      ids = Object.keys(state.sessions)
    }

    // 2) 每会话轮次上限
    for (const id of ids) {
      const s = state.sessions[id]
      const keys = Object.keys(s.turns || {})
      if (keys.length > maxTurns) {
        keys.sort((a, b) => Number(b) - Number(a))
        for (const k of keys.slice(maxTurns)) delete s.turns[k]
      }
    }

    // 3) 会话数上限（按 lastTs 降序保留最新的）
    if (ids.length > maxSessions) {
      ids.sort((a, b) => (state.sessions[b]?.lastTs || 0) - (state.sessions[a]?.lastTs || 0))
      for (const id of ids.slice(maxSessions)) delete state.sessions[id]
    }

    // 4) 体积上限：继续裁最旧会话
    let size = safeJsonSize(state)
    if (size > maxBytes) {
      const rest = Object.keys(state.sessions).sort(
        (a, b) => (state.sessions[b]?.lastTs || 0) - (state.sessions[a]?.lastTs || 0)
      )
      while (rest.length > 1 && size > maxBytes) {
        const victim = rest.pop()
        size -= safeJsonSize(state.sessions[victim]) + victim.length + 16
        delete state.sessions[victim]
      }
    }
  }

  function safeJsonSize(v) {
    try {
      return JSON.stringify(v).length
    } catch {
      return 0
    }
  }

  function touch() {
    dirty = true
    state.updatedAt = new Date().toISOString()
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      schedule()
    }, Number(cfg.debounceMs || 400))
  }

  function schedule() {
    if (!dirty) return
    dirty = false
    queue = queue.then(writeOnce).catch((err) => warn(`[dsh-turn-cost] write failed: ${String(err?.message || err)}`))
  }

  async function writeOnce() {
    try {
      pruneIfNeeded()
      const body = JSON.stringify(state)
      const dir = path.dirname(filePath)
      await fs.promises.mkdir(dir, { recursive: true })
      const tmp = `${filePath}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, body, 'utf8')
      await fs.promises.rename(tmp, filePath)
    } catch (err) {
      warn(`[dsh-turn-cost] persist failed: ${String(err?.message || err)}`)
    }
  }

  /** 卸载时同步 flush，尽量不丢最后几秒的数据 */
  function flushSync() {
    if (!dirty) return
    dirty = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      pruneIfNeeded()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(state), 'utf8')
    } catch {}
  }

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const doc = JSON.parse(raw)
      if (doc && doc.version === 1 && doc.sessions && typeof doc.sessions === 'object') {
        state.version = 1
        state.updatedAt = doc.updatedAt || null
        state.sessions = doc.sessions
        return
      }
      throw new Error('unexpected shape')
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // 坏文件改名保留现场，以空状态启动（不阻塞 dsh 启动）
        try {
          fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
        } catch {}
        warn(`[dsh-turn-cost] turns.json unreadable, starting empty: ${String(err?.message || err)}`)
      }
    }
  }

  /* ---------------- 事件归约（live 与 replay 共用） ---------------- */

  function newAgg(turn) {
    return { turn, amount: 0, tokens: 0, models: new Set(), hasPriced: false, peak: false, lastTs: 0 }
  }

  function sessionOf(sessionId) {
    let s = state.sessions[sessionId]
    if (!s) {
      s = { lastTs: 0, turns: {} }
      state.sessions[sessionId] = s
    }
    return s
  }

  /**
   * 喂一条会话事件。
   * @param {string} sessionId
   * @param {{type:string, time?:number, data?:any}} ev
   * @param {'live'|'replay'} origin
   */
  function feed(sessionId, ev, origin) {
    const data = ev?.data
    if (!data) return
    const turn = Number(data.turn)
    if (!Number.isFinite(turn)) return

    if (ev.type === 'turn/end') {
      finalize(sessionId, origin)
      return
    }
    if (ev.type !== 'assistant/message') return

    let agg = liveAggs.get(sessionId)
    if (!agg || agg.turn !== turn) {
      if (agg) finalize(sessionId, origin) // turn 切换兜底结算
      agg = newAgg(turn)
      liveAggs.set(sessionId, agg)
    }

    const at = Number(ev.time) || Date.now()
    const { cost, tokens, priced, peak, model } = costOf(data.usage, data.message?.source, at, cfg)

    agg.amount = addMoney(agg.amount, cost)
    agg.tokens += tokens
    if (priced) agg.hasPriced = true
    if (peak) agg.peak = true
    if (model) agg.models.add(model)
    if (at > agg.lastTs) agg.lastTs = at
  }

  function finalize(sessionId, origin) {
    const agg = liveAggs.get(sessionId)
    if (!agg) return
    liveAggs.delete(sessionId)
    if (!(agg.amount > 0)) return // 0 金额不落库、不显示

    const s = sessionOf(sessionId)
    const key = String(agg.turn)
    const prev = s.turns[key]
    // live 数据优先：已由实时事件记录过的轮次，回填不覆盖
    if (prev && prev.src === 'live' && origin === 'replay') return

    const rec = {
      amount: preciseMoney(agg.amount),
      tokens: agg.tokens,
      models: [...agg.models],
      peak: !!agg.peak,
      priced: agg.hasPriced,
      ts: agg.lastTs || Date.now(),
      src: origin,
    }
    // 上下文占用快照：仅 live 轮次（replay 的投影值只代表"现在"，不代表那一轮结束时刻）
    if (origin === 'live' && pressureOf) {
      try {
        const p = pressureOf(sessionId)
        if (p && Number.isFinite(p.used) && Number.isFinite(p.total) && p.total > 0) {
          rec.ctx = { used: p.used, total: p.total, ratio: p.used / p.total }
        }
      } catch {}
    }
    s.turns[key] = rec
    if ((s.turns[key].ts || 0) > (s.lastTs || 0)) s.lastTs = s.turns[key].ts
    touch()
  }

  /* ---------------- 查询 ---------------- */

  function candidates(limit = 8) {
    return Object.entries(state.sessions)
      .map(([id, s]) => ({
        id,
        lastTs: s.lastTs || 0,
        maxTurn: Math.max(0, ...Object.keys(s.turns || {}).map(Number)),
        turns: Object.keys(s.turns || {}).length,
      }))
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, limit)
  }

  return {
    feed,
    finalize,
    observed,
    touch,
    flushSync,
    markLive: (sid) => observed.add(sid),
    drop: (sid) => liveAggs.delete(sid),
    /** 该会话此刻是否有进行中的实时聚合（用于回填/实时竞态判定） */
    isLive: (sid) => liveAggs.has(sid),
    hasSession: (sid) => {
      const s = state.sessions[sid]
      return !!(s && s.turns && Object.keys(s.turns).length)
    },
    turnsOf: (sid) => state.sessions[sid]?.turns || {},
    candidates,
    revOf: () => state.updatedAt,
    /** 会话级修订号（该会话最后一次更新的毫秒时间戳）。比全局 updatedAt 精确：
     *  别的会话变化不会让本会话的 304 失效，避免无谓的全量重传。 */
    sessionRev: (sid) => state.sessions[sid]?.lastTs || 0,
    file: () => filePath,
  }
}
