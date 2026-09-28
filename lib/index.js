import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLedger } from './ledger.mjs'
import { createBackfiller } from './backfill.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.join(HERE, '..', 'assets', 'client.js')

const NS = '/dsh-turn-cost'
const CLIENT_PATH = `${NS}/client.js`
const TURNS_PATH = `${NS}/turns.json`
const COMPACT_PATH = `${NS}/compact`

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

const DEFAULTS = {
  decimals: null,
  tinyLabel: '¥<0.0001',
  currency: '¥',
  pollMs: 1200,
  pollMsHidden: 6000,
  priceUnknownProviders: false,
  includeCacheWrite: false,
  ttlDays: 30,
  maxSessions: 200,
  maxTurnsPerSession: 2000,
  maxBytes: 4194304,
  backfill: true,
  maxReplayEvents: 50000,
  debounceMs: 400,
  // ===== 上下文占用 =====
  showContext: true,          // 是否在金额前显示上下文占用
  compactTimeoutMs: 120000,   // 触发 /compact 的超时
}

/* ---------------- 前端脚本：按 mtime 缓存，改完刷新页面即可生效 ---------------- */

let clientCache = null
function loadClientJs() {
  try {
    const st = fs.statSync(CLIENT_FILE)
    if (clientCache && clientCache.mtimeMs === st.mtimeMs) return clientCache.text
    const text = fs.readFileSync(CLIENT_FILE, 'utf8')
    clientCache = { text, mtimeMs: st.mtimeMs }
    return text
  } catch {
    return ''
  }
}

/* ---------------- 回环 + 同源护栏（fail-closed） ---------------- */

function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (h.startsWith('127.')) {
    const parts = h.split('.')
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
      return parts.every((p) => Number(p) <= 255)
    }
  }
  return false
}

/** 返回 true 表示已拒绝并写回响应 */
function sameOriginGuard(req, res) {
  const deny = (code, text) => {
    try {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(text)
    } catch {}
    return true
  }
  let hostUrl
  try {
    hostUrl = new URL('http://' + String(req.headers.host || ''))
  } catch {
    return deny(403, 'forbidden')
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return deny(403, 'forbidden')
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny(403, 'forbidden')
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(403, 'forbidden')
    } catch {
      return deny(403, 'forbidden')
    }
  }
  return false
}

/** 读取请求体，超限或失败返回 '' */
function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        finish('')
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(c)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(''))
    req.on('aborted', () => finish(''))
  })
}

function publicCfg(c) {
  return {
    decimals: c.decimals ?? null,
    tinyLabel: c.tinyLabel,
    currency: c.currency,
    pollMs: c.pollMs,
    pollMsHidden: c.pollMsHidden,
    backfill: !!c.backfill,
    showContext: !!c.showContext,
  }
}

/** 前端只消费 amount 与 ctx（环 + 气泡）。轮次上限 2000，去掉 tokens/models/ts/src
 *  等未被读取的字段后，轮询响应体大幅缩小。 */
function slimTurns(turns) {
  const out = {}
  for (const k of Object.keys(turns || {})) {
    const r = turns[k] || {}
    const rec = { amount: r.amount }
    if (r.ctx) rec.ctx = r.ctx
    out[k] = rec
  }
  return out
}

function json(res, obj) {
  res.writeHead(200, JSON_HEADERS)
  res.end(JSON.stringify(obj))
}

export default {
  name: 'dsh-turn-cost',

  // 配置经 apply 的第二个参数传入。不能读 root.config —— 本插件有意不使用对象级
  // inject（否则整个 apply 会被推迟到 webServer 就绪之后，可能错过宿主启动时
  // 一次性收集的注入表，见 dsh-whale-widget 同名注释），而未声明 inject 时
  // cordis 会拒绝访问 ctx.config（"cannot get property config without inject"）。
  apply(root, config) {
    const disposers = []
    const cfg = { ...DEFAULTS, ...(config || {}) }

    // 会话/命令/投影服务：延迟获取。与 dsh-command-compact 同源的服务名：
    // agents（dsh-agent/lib/index.js:332）、commands、sessionProjections。
    // 用可变引用保存，这样即使它们晚于 webServer 就绪，路由也能自动开始工作。
    const svc = { agents: null, commands: null, projections: null, sessions: null }
    root.inject(['agents', 'commands', 'sessionProjections'], (c) => {
      svc.agents = c.agents || null
      svc.commands = c.commands || null
      svc.projections = c.sessionProjections || null
      svc.sessions = c.sessions || null
    })

    // ① 结构化注入前端脚本。放在 head 是为了早于聊天界面渲染，
    //    让首屏历史轮次也能立刻拿到金额。这一行不需要等 webServer 就绪。
    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          if (table.some((r) => r && r.kind === 'script-src' && r.src === CLIENT_PATH)) return
          table.push({ kind: 'script-src', placement: 'head', src: CLIENT_PATH })
        } catch {}
      })
    )

    // ② 主逻辑：等 webServer 服务就绪再注册路由与事件订阅
    // 读取某会话当前的上下文占用。
    // 口径与官方一致（dsh-client-ui-conversation/lib/client.js:16833 contextOccupancy）：
    //   分子 = projectedTokens ?? pressureTokens，分母 = contextWindow
    // projectedTokens 由投影的 wire 算出：pressureTokens + (surfaceTokens - sampledSurfaceTokens)
    function readPressure(sessionId) {
      if (!svc.projections) return null
      try {
        const id = String(sessionId)
        const agent = svc.agents ? svc.agents.get(id) : undefined
        const session = agent?.session || (svc.sessions ? svc.sessions.get(id) : undefined)
        if (!session) return null
        const st = svc.projections.stateOf(session, 'contextPressure')
        if (!st) return null
        const total = st.contextWindow
        let used = st.pressureTokens
        if (
          st.pressureTokens !== undefined &&
          st.surfaceTokens !== undefined &&
          st.sampledSurfaceTokens !== undefined
        ) {
          used = Math.max(0, st.pressureTokens + st.surfaceTokens - st.sampledSurfaceTokens)
        }
        if (used === undefined || total === undefined || !(total > 0)) return null
        return { used, total, ratio: used / total }
      } catch {
        return null
      }
    }

    root.inject(['webServer'], (ctx) => {
      const ledger = createLedger(cfg, ctx.logger, { pressure: readPressure })
      const backfiller = createBackfiller(ledger, cfg, ctx.logger)

      // 会话持久化服务（用于历史回填）；缺失则静默降级
      let sp = null
      try {
        ctx.inject(['sessionPersistence'], (c2) => {
          sp = c2.sessionPersistence || null
        })
      } catch {}

      const log = (m) => {
        try {
          ctx.logger?.warn?.(m)
        } catch {}
      }

      // ②-a 实时事件：按 (sessionId, turn) 分桶，turn/end 结算
      disposers.push(
        ctx.on('session/event', (session, event) => {
          try {
            const sid = session && session.id ? session.id : 'default'
            ledger.markLive(sid)
            ledger.feed(sid, { type: event?.type, time: event?.time, data: event?.data }, 'live')
          } catch (err) {
            log(`[dsh-turn-cost] session/event failed: ${String(err?.message || err)}`)
          }
        })
      )
      disposers.push(
        ctx.on('session/disposed', (session) => {
          try {
            if (session?.id) ledger.drop(session.id)
          } catch {}
        })
      )

      // ②-b 请求护栏：自家回环/同源 + connection.requestRejection（浏览器 cookie 鉴权）
      function rejected(req, res) {
        if (sameOriginGuard(req, res)) return true
        try {
          const conn = ctx.get?.('connection') || ctx.connection
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req)
            if (code) {
              res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('forbidden')
              return true
            }
          }
        } catch {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return true
        }
        return false
      }

      const register = (route) => {
        disposers.push(
          ctx.webServer.register({
            ...route,
            handler: (req, res) => {
              if (rejected(req, res)) return
              try {
                return route.handler(req, res)
              } catch (err) {
                log(`[dsh-turn-cost] ${route.path} failed: ${String(err?.message || err)}`)
                try {
                  json(res, { ok: false, error: String(err?.message || err).slice(0, 200) })
                } catch {}
              }
            },
          })
        )
      }

      /**
       * 触发一次上下文压缩。走 ctx.commands.execute(agent, '/compact') —— 与用户在输入框
       * 手打 /compact 完全同一条官方路径，因此自带 commandId 铸造、command/run 与
       * command/done 持久化日志、错误分类（busy/changed/summary/...）与 abort 处理。
       * 不直接调 ctx.compaction.compactNow：那样拿不到命令级的结果分类与日志。
       */
      async function runCompact(sid) {
        if (!svc.agents || !svc.commands) {
          return { ok: false, text: '压缩服务未就绪（agents/commands 未加载）' }
        }
        if (!sid) return { ok: false, text: '未指定会话' }

        const agent = svc.agents.get(String(sid))
        if (!agent) return { ok: false, text: '会话未存活（可能尚未加载）' }

        // 预检只能减少误触发，无法消除竞态 —— maintenance 阶段也上报 idle，所以仍需 catch busy
        try {
          if (agent.status && agent.status !== 'idle') {
            return { ok: false, text: '会话正忙，请等当前轮次结束后再试' }
          }
        } catch {}

        try {
          if (typeof svc.commands.find === 'function' && !svc.commands.find(agent, 'compact')) {
            return { ok: false, text: '/compact 命令未注册' }
          }
        } catch {}

        const controller = new AbortController()
        const timer = setTimeout(() => {
          try {
            controller.abort()
          } catch {}
        }, Number(cfg.compactTimeoutMs) || 120000)

        try {
          const exec = await svc.commands.execute(agent, '/compact', [], controller.signal)
          if (exec === undefined) return { ok: false, text: '/compact 未能解析' }
          if (exec.result?.kind === 'success') {
            return { ok: true, text: exec.result.text || '已压缩' }
          }
          return { ok: false, text: exec.result?.text || '压缩失败' }
        } catch (err) {
          const msg = String(err?.message || err)
          // 官方命令已把 ManualCompactionError 翻译成人类可读文案，这里只做兜底映射
          if (/busy/i.test(msg)) return { ok: false, text: '会话正忙或有压缩正在进行，请稍后重试' }
          return { ok: false, text: msg }
        } finally {
          clearTimeout(timer)
        }
      }

      // GET /dsh-turn-cost/client.js
      register({
        kind: 'exact',
        path: CLIENT_PATH,
        handler: (req, res) => {
          const body = loadClientJs()
          if (!body) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('client script missing')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(body)
        },
      })

      // GET /dsh-turn-cost/turns.json?session=<id>[&rev=<ms>][&lite=1]
      //
      // 归属规则（P1-A 修复的核心）：
      //   · 客户端点名了会话 → 只回该会话。没有数据就回 source:'pending' + 空 turns，
      //     绝不回退到「最近会话」把别人的金额冒充给它。
      //   · 客户端没点名（首屏容器尚未渲染出来）→ 才允许回退到最近会话引导一次；
      //     客户端一旦从 DOM 读到真实会话就会自行纠正并重新请求。
      register({
        kind: 'exact',
        path: TURNS_PATH,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://x')
          const asked = url.searchParams.get('session') || ''
          const rev = url.searchParams.get('rev') || ''
          const lite = url.searchParams.get('lite') === '1'
          let sid = asked
          let source = 'exact'

          if (sid) {
            if (!ledger.hasSession(sid)) await backfiller.ensure(sp, sid)
            if (!ledger.hasSession(sid)) {
              // 该会话确实（还）没有数据 —— 如实告知，不用别的会话冒充
              json(res, {
                ok: true,
                session: sid,
                source: 'pending',
                rev: null,
                turns: {},
                candidates: ledger.candidates(8),
                cfg: publicCfg(cfg),
              })
              return
            }
          } else {
            const cands = ledger.candidates(8)
            if (!cands.length) {
              json(res, { ok: true, session: null, source: 'empty', rev: null, turns: {}, candidates: [], cfg: publicCfg(cfg) })
              return
            }
            sid = cands[0].id
            source = 'latest'
          }

          const curRev = String(ledger.sessionRev(sid) || '')
          if (rev && String(rev) === curRev) {
            res.writeHead(304)
            res.end()
            return
          }

          json(res, {
            ok: true,
            session: sid,
            source,
            rev: curRev,
            turns: lite ? slimTurns(ledger.turnsOf(sid)) : ledger.turnsOf(sid),
            candidates: ledger.candidates(8),
            cfg: publicCfg(cfg),
          })
        },
      })

      // POST /dsh-turn-cost/compact —— 触发该会话的 /compact（等价于用户手打命令）
      register({
        kind: 'exact',
        path: COMPACT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          let sid = ''
          try {
            const raw = await readBody(req, 4096)
            if (raw) {
              const parsed = JSON.parse(raw)
              sid = String(parsed?.session || '')
            }
          } catch {}
          // 压缩是写操作：客户端没点名会话时绝不能猜 —— 猜错就会去压缩别的会话
          if (!sid) {
            json(res, { ok: false, text: '未指定会话（请刷新页面后重试）' })
            return
          }
          json(res, await runCompact(sid))
        },
      })

      ctx.effect(() => () => {
        ledger.flushSync()
      })
    })

    root.effect(() => () => {
      for (const d of disposers.splice(0)) {
        try {
          d()
        } catch {}
      }
    })
  },
}
