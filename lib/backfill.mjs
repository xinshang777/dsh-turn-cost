/**
 * 用已经落盘的会话事件（ctx.sessionPersistence）把插件安装之前的历史轮次也算成金额。
 * 惰性触发：每个 sessionId 每进程只做一次；失败静默降级，不影响实时轮次。
 */
export function createBackfiller(ledger, cfg, logger) {
  const done = new Set()
  const inflight = new Map()

  async function ensure(sessionPersistence, sessionId) {
    if (!cfg.backfill || !sessionPersistence || !sessionId) return
    if (ledger.hasSession(sessionId)) return // 已有数据（通常是 live 攒的）
    if (done.has(sessionId)) return
    if (inflight.has(sessionId)) return inflight.get(sessionId)

    const task = (async () => {
      let handle = null
      try {
        handle = await sessionPersistence.open(sessionId, 'read')
        if (!handle) return
        let offset = 0
        const cap = Number(cfg.maxReplayEvents || 50000)

        for (;;) {
          const res = await handle.read(offset, 500)
          const events = res?.events || []
          if (!events.length) break
          offset += events.length
          for (const ev of events) {
            if (ev.type !== 'assistant/message' && ev.type !== 'turn/end') continue
            ledger.feed(sessionId, { type: ev.type, time: ev.time, data: ev.data }, 'replay')
          }
          if (offset > cap) break
        }

        ledger.finalize(sessionId, 'replay') // 日志末尾未闭合的那一轮也闭掉
        ledger.touch()
      } catch (err) {
        try {
          logger?.warn?.(`[dsh-turn-cost] backfill ${sessionId} failed: ${String(err?.message || err)}`)
        } catch {}
      } finally {
        try {
          if (handle && typeof handle.close === 'function') await handle.close()
        } catch {}
        done.add(sessionId)
        inflight.delete(sessionId)
      }
    })()

    inflight.set(sessionId, task)
    return task
  }

  return { ensure }
}
