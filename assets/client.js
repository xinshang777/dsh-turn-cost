/* dsh-turn-cost —— 在每轮 assistant 时间戳正后方显示：环形上下文占用 + 该轮费用金额。
 *
 * 布局：时间戳 [ 环形上下文占用(可点击) ] [ ¥金额 ]
 * 交互：点击环形 → 弹出气泡，气泡内“压缩上下文”按钮才会真正调用 dsh 自带 /compact。
 *
 * 注入点：div[data-clock="end"] 的最后一个子元素 span（= endInfo），
 *         其内部是 [usageAction?, span.timeEnd]，往末尾 append 即落在时间戳之后。
 * 不使用任何 CSS 类名定位 —— 类名是构建期哈希（如 xzv4MW_endInfo / xzv4MW_timeEnd）。
 */
(function () {
  'use strict'
  if (window.__DSH_TURN_COST__) return

  var API = '/dsh-turn-cost/turns.json'
  var COMPACT_API = '/dsh-turn-cost/compact'
  var TAG = 'data-dsh-turn-cost'
  var ROLE = 'data-dsh-turn-cost-role'
  var SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

  var W = (window.__DSH_TURN_COST__ = {
    session: null,
    source: null,
    rev: null,
    turns: {},
    cfg: {},
    lastKey: '',
    dark: null,
    debug: { fiber: null, matched: 0 },
  })

  /* ---------------- L1/L2：从 React fiber 取 sessionId ---------------- */

  function fiberOf(el) {
    var keys = Object.keys(el)
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactContainer$') === 0) {
        return el[keys[i]]
      }
    }
    for (var k in el) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0) return el[k]
    }
    return null
  }

  function sessionIdFrom(el) {
    var f = fiberOf(el)
    var hops = 0
    while (f && hops++ < 5000) {
      var p = f.memoizedProps
      if (p && typeof p === 'object') {
        if (typeof p.sessionId === 'string' && p.sessionId) {
          W.debug.fiber = 'L1'
          return p.sessionId
        }
        for (var k in p) {
          var v = p[k]
          if (typeof v === 'string' && SESSION_RE.test(v)) {
            W.debug.fiber = 'L2'
            return v
          }
          if (typeof v === 'string' && UUID_RE.test(v) && v.length < 64) {
            W.debug.fiber = 'L2u'
            return 'session-' + v.match(UUID_RE)[0]
          }
        }
      }
      f = f.return
    }
    W.debug.fiber = 'none'
    return null
  }

  /* ---------------- 会话标识：以官方 DOM 属性为准 ----------------
   * 官方在主对话容器上渲染 data-conversation-session="<sessionId>"
   * （dsh-client-ui-conversation/lib/client.js:16256），dsh 自身也用
   * `target.closest('[data-conversation-session]')` 取会话。
   * 这是稳定来源；爬 React fiber 在实测中取不到值，只作兜底。
   */

  function domSessionId(fromEl) {
    try {
      var host = fromEl && fromEl.closest ? fromEl.closest('[data-conversation-session]') : null
      if (!host) return null
      var v = host.getAttribute('data-conversation-session')
      if (v && SESSION_RE.test(v)) return v
    } catch (e) {}
    return null
  }

  /* 把 W.session 纠正到 DOM 里的真实会话，返回 true 表示发生了变化。
   * 关键：不能像旧实现那样只在 W.session 为空时写入 —— 那样一旦被服务端的
   * “最近会话”占了位就永远无法纠正，表现就是「切了会话却显示别人的金额」。 */
  function syncSession() {
    var tails = document.querySelectorAll('[data-turn-tail]')
    if (!tails.length) return false
    var sid = domSessionId(tails[0]) || sessionIdFrom(tails[0])
    if (!sid || sid === W.session) return false
    W.session = sid
    W.rev = null
    W.turns = {} // 立刻丢弃上一个会话的数据，避免任何一帧显示到别人身上
    W.lastKey = ''
    return true
  }

  /* ---------------- 定位注入点 ---------------- */

  function scan(cb) {
    var tails = document.querySelectorAll('[data-turn-tail]')
    for (var i = 0; i < tails.length; i++) {
      var turn = tails[i].getAttribute('data-turn-tail')
      if (turn === null || turn === '') continue
      var actions = tails[i].querySelector('[data-clock="end"]')
      if (!actions) continue // 轮次未闭合 → 不显示
      var info = actions.lastElementChild // = endInfo
      if (!info || info.tagName !== 'SPAN') continue
      if (!/\d/.test(info.textContent || '')) continue // 保险：确认这里确实渲染了时间
      cb(turn, info)
    }
  }

  /* ---------------- 数值格式化 ---------------- */

  function fmtTokens(n) {
    n = Number(n) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return String(n)
  }

  function costLabelOf(rec) {
    // 宁可缺失也不造假：金额非有限正数（含 0 / NaN / Infinity / 未知计价）→ 不显示，
    // 绝不渲染 ¥0.00 或任何占位值去误导用户
    if (!rec || !Number.isFinite(rec.amount) || !(rec.amount > 0)) return ''
    var a = rec.amount
    var d = W.cfg.decimals
    if (d === null || d === undefined) d = a >= 1 ? 2 : a >= 0.01 ? 3 : 4
    var s = a.toFixed(d)
    if (Number(s) === 0) return W.cfg.tinyLabel || '¥<0.0001'
    return (W.cfg.currency || '¥') + s
  }

  function ratioOf(rec) {
    if (W.cfg.showContext === false) return -1
    var c = rec && rec.ctx
    // 宁可缺失也不造假：无 ctx / total 无效 / ratio 非有限数 → 不显示环
    if (!c || !Number.isFinite(c.total) || !(c.total > 0) || !Number.isFinite(c.ratio)) return -1
    return Math.max(0, Math.min(1, c.ratio))
  }

  /* ---------------- 环形 SVG ---------------- */

  function ringInner(ratio) {
    var pct = Math.max(0, Math.min(1, ratio || 0))
    var r = 9
    var circ = 2 * Math.PI * r
    var off = circ * (1 - pct)
    var color = pct >= 0.8 ? '#e74c3c' : pct >= 0.5 ? '#f1c40f' : '#3ba55d'
    var pctText = Math.round(pct * 100)
    return (
      '<svg width="22" height="22" viewBox="0 0 24 24" style="display:block">' +
      '<g transform="rotate(-90 12 12)">' +
      '<circle cx="12" cy="12" r="' + r + '" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"/>' +
      '<circle cx="12" cy="12" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="3" ' +
      'stroke-linecap="round" stroke-dasharray="' + circ.toFixed(2) + '" ' +
      'stroke-dashoffset="' + off.toFixed(2) + '"/></g>' +
      '<text x="12" y="12" text-anchor="middle" dominant-baseline="central" ' +
      'font-size="8.5" font-weight="700" fill="' + color + '">' + pctText + '</text>' +
      '</svg>'
    )
  }

  /* ---------------- 确认气泡（全局单例） ---------------- */

  var pop = null
  var styleEl = null

  /* 主题适配：dsh 在 <body> 上以 data-ds-dark-theme 标记暗色
   * （dsh-client-ui-theme 的 bootThemeBodyScript: body.toggleAttribute('data-ds-dark-theme', dark)）。
   * 用 CSS 选择器而非内联色，主题切换时浏览器自动重算，无需 JS 重绘。 */
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return
    styleEl = document.createElement('style')
    styleEl.setAttribute('data-dsh-turn-cost-style', '')
    styleEl.textContent =
      '#__dsh_tc_pop{background:#ffffff;color:#1f2329;border:1px solid #e3e6ea}' +
      '#__dsh_tc_pop [data-p="sub"]{color:#6b7280}' +
      '#__dsh_tc_pop .tcc{background:#f6f7f9;color:#1f2329;border:1px solid #d0d5dd}' +
      'body[data-ds-dark-theme] #__dsh_tc_pop{background:#1f2329;color:#e8eaed;border-color:#3a3f47}' +
      'body[data-ds-dark-theme] #__dsh_tc_pop [data-p="sub"]{color:#9aa0a6}' +
      'body[data-ds-dark-theme] #__dsh_tc_pop .tcc{background:#2a2e34;color:#e8eaed;border-color:#454b54}'
    ;(document.head || document.documentElement).appendChild(styleEl)
  }

  function ensurePop() {
    if (pop) return pop
    ensureStyle()
    pop = document.createElement('div')
    pop.id = '__dsh_tc_pop'
    pop.setAttribute('role', 'dialog')
    pop.style.cssText =
      'position:fixed;z-index:99999;min-width:210px;max-width:280px;' +
      'border-radius:12px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.20);padding:13px 15px;font-size:13px;line-height:1.5;' +
      'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:none'

    pop.innerHTML =
      '<div data-p="title" style="font-weight:700;font-size:14px;margin-bottom:4px"></div>' +
      '<div data-p="sub" style="font-size:12px;margin-bottom:12px"></div>' +
      '<div data-p="row" style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button data-p="cancel" class="tcc" type="button" style="' +
      'padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px">取消</button>' +
      '<button data-p="go" class="tcc" type="button" style="' +
      'padding:6px 12px;border:1px solid #cf3a3a;background:#e74c3c;color:#fff;' +
      'border-radius:8px;cursor:pointer;font-size:13px;font-weight:600">压缩上下文</button>' +
      '</div>'

    document.body.appendChild(pop)
    pop.querySelector('[data-p="cancel"]').addEventListener('click', closePop)
    pop.querySelector('[data-p="go"]').addEventListener('click', function () {
      if (pop._busy) return
      doCompact(pop._turn)
    })

    document.addEventListener('mousedown', function (e) {
      if (!pop || pop.style.display === 'none') return
      if (pop._busy) return // 压缩进行中不允许误关
      var t = e.target
      if (pop.contains(t)) return
      if (t && t.closest && t.closest('[data-dsh-turn-cost-role="ctx"]')) return
      closePop()
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && pop.style.display !== 'none') closePop()
    })
    return pop
  }

  function closePop() {
    if (pop) pop.style.display = 'none'
  }

  function openPop(turn, anchor) {
    var p = ensurePop()
    var rec = W.turns[turn] || {}
    var c = rec.ctx || {}
    var ratio = Math.max(0, Math.min(1, c.ratio || 0))
    var used = Number(c.used) || 0
    var total = Number(c.total) || 0

    p._turn = turn
    p._busy = false
    p.querySelector('[data-p="title"]').textContent = '上下文占用 ' + Math.round(ratio * 100) + '%'
    p.querySelector('[data-p="sub"]').textContent =
      fmtTokens(used) + ' / ' + fmtTokens(total) + ' tokens（点击按钮压缩当前会话）'
    var go = p.querySelector('[data-p="go"]')
    go.disabled = false
    go.textContent = '压缩上下文'
    go.style.opacity = '1'

    p.style.display = 'block'
    var r = anchor.getBoundingClientRect()
    var pw = p.offsetWidth || 230
    var ph = p.offsetHeight || 110
    var x = Math.min(r.left, window.innerWidth - pw - 8)
    if (x < 8) x = 8
    var y = r.bottom + 6
    if (y + ph > window.innerHeight - 8) y = r.top - ph - 6 // 底部空间不足则翻到上方
    if (y < 8) y = 8
    p.style.left = x + 'px'
    p.style.top = y + 'px'
  }

  /* ---------------- 压缩（dsh 自带 /compact） ---------------- */

  function doCompact(turn) {
    var p = ensurePop()
    p._busy = true
    var go = p.querySelector('[data-p="go"]')
    go.disabled = true
    go.textContent = '压缩中…'
    go.style.opacity = '.7'

    fetch(COMPACT_API, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: W.session || '' }),
    })
      .then(function (r) {
        return r.ok ? r.json() : { ok: false, text: '请求失败（HTTP ' + r.status + '）' }
      })
      .then(function (d) {
        var txt = d && d.text ? d.text : d && d.ok ? '已压缩' : '压缩失败'
        go.textContent = txt
        setTimeout(closePop, 2400)
        kick()
      })
      .catch(function () {
        go.textContent = '压缩请求失败'
        setTimeout(closePop, 2400)
      })
  }

  /* ---------------- 幂等渲染：以 DOM 真实状态为准，React 重渲染后自动修复 ----------------
   * 关键修复：不再用 WeakMap 以「时间戳 DOM 节点」缓存「已渲染」状态。
   * dsh 聊天界面是 React 应用，重渲染时会保留旧节点对象、却把我们在其内部注入的
   * 金额节点当作外来节点剔除；若仍信任 WeakMap，会误判「已渲染」而永久跳过，
   * 表现为「时有时无、好几轮没有」。改为：每次渲染都先到 DOM 里找金额节点，
   * 被冲掉就重建；仅当节点存在且内容一致时才跳过（避免重建闪烁）。
   */

  var rendering = false

  function render() {
    if (rendering) return
    rendering = true
    var adopted = false
    try {
      adopted = syncSession()
      scan(function (turn, info) {
        var rec = W.turns[turn]
        var ratio = ratioOf(rec)
        var mWant = costLabelOf(rec)
        var ratioKey = ratio < 0 ? 'x' : String(Math.round(ratio * 100))
        var key = ratioKey + ' ' + mWant

        // ① 在 DOM 中找已注入的金额节点（不以任何缓存为准）
        var wrap = null
        var kids = info.children
        for (var i = kids.length - 1; i >= 0; i--) {
          if (kids[i].tagName === 'SPAN' && kids[i].getAttribute(TAG) === String(turn)) {
            wrap = kids[i]
            break
          }
        }

        // ② 既不显示环也不需要金额 → 无需创建；若已由显示转为不显示则移除
        if (ratio < 0 && !mWant) {
          if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap)
          return
        }

        if (!wrap) {
          wrap = document.createElement('span')
          wrap.setAttribute(TAG, String(turn))
          wrap.style.cssText =
            'margin-left:6px;font-variant-numeric:tabular-nums;white-space:nowrap;' +
            'display:inline-flex;align-items:center;gap:5px'

          var cs = document.createElement('span')
          cs.setAttribute(ROLE, 'ctx')
          cs.style.cssText =
            'display:inline-flex;align-items:center;cursor:pointer;vertical-align:middle'
          cs.title = '上下文占用 —— 点击进行压缩'
          cs.addEventListener('click', function (e) {
            e.stopPropagation()
            openPop(turn, cs)
          })

          var ms = document.createElement('span')
          ms.setAttribute(ROLE, 'cost')
          ms.style.cssText = 'pointer-events:none'
          ms.title = '本轮对话费用'

          wrap.appendChild(cs)
          wrap.appendChild(ms)
          info.appendChild(wrap)
        } else if (wrap.getAttribute('data-key') === key) {
          // 节点存在且内容一致 → 跳过（React 完整保留时的快速路径，防闪烁）
          return
        }
        wrap.setAttribute('data-key', key)
        // React 开启「详细」用量面板后会往 endInfo 里追加节点：确保我们始终留在末尾
        // （= 时间戳之后），而不是被挤到用量面板前面
        if (info.lastElementChild !== wrap) info.appendChild(wrap)

        var ctxEl = wrap.firstElementChild
        var costEl = wrap.lastElementChild
        if (ctxEl && ratio >= 0) {
          ctxEl.style.display = ''
          if (ctxEl.getAttribute('data-ring') !== ratioKey) {
            ctxEl.innerHTML = ringInner(ratio)
            ctxEl.setAttribute('data-ring', ratioKey)
          }
          var ttl = '上下文占用 ' + Math.round(ratio * 100) + '% —— 点击压缩'
          if (ctxEl.getAttribute('title') !== ttl) ctxEl.title = ttl
        } else if (ctxEl) {
          ctxEl.style.display = 'none'
        }
        if (costEl && costEl.textContent !== mWant) costEl.textContent = mWant
      })
    } finally {
      rendering = false
    }
    // 会话被纠正（切换/新建）→ 立刻按新会话拉一次，不必等下一次轮询
    if (adopted) kick()
  }

  /* ---------------- 拉取 ---------------- */

  function fetchTurns() {
    var q = '?session=' + encodeURIComponent(W.session || '') + '&lite=1'
    if (W.rev) q += '&rev=' + encodeURIComponent(W.rev)
    return fetch(API + q, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.status === 304 ? null : r.ok ? r.json() : null
      })
      .then(function (d) {
        if (!d || !d.ok) return
        if (d.cfg) {
          W.cfg = d.cfg
          W.pollMs = d.cfg.pollMs
          W.pollMsHidden = d.cfg.pollMsHidden
        }
        // 服务端回的是别的会话 → 直接丢弃，绝不让 A 会话的金额渲染到 B 会话上
        if (d.session && W.session && d.session !== W.session) return
        // 客户端还不知道会话（首屏容器尚未渲染）→ 采纳服务端的引导值
        if (d.session && !W.session) W.session = d.session
        W.source = d.source || 'exact'
        W.turns = d.turns || {}
        W.rev = d.rev || null
        W.debug.matched = Object.keys(W.turns).length
        render()
      })
      .catch(function () {})
  }

  /* ---------------- 调度：observer 即时补偿 + 自适应轮询 ---------------- */

  var timer = null
  var mo = null
  var deb = null
  var pendingRender = 0
  var lastRenderAt = 0

  function scheduleNext() {
    if (timer) clearTimeout(timer)
    var ms = document.visibilityState === 'hidden' ? W.pollMsHidden || 6000 : W.pollMs || 1200
    timer = setTimeout(function () {
      timer = null
      fetchTurns().then(scheduleNext)
    }, ms)
  }

  function kick() {
    if (deb) clearTimeout(deb)
    deb = setTimeout(function () {
      deb = null
      fetchTurns()
    }, 300)
  }

  function signature() {
    var parts = []
    scan(function (turn) {
      parts.push(turn)
    })
    return (W.session || '') + '|' + parts.join(',')
  }

  /* React 流式输出时 DOM 每秒可变更数十次。用固定 16ms 的合并窗口，把窗口内的多次
   * 变更合并成一次全量扫描（render() 与 signature() 各要完整遍历一遍所有轮次）。
   * 刻意不用 requestAnimationFrame：其触发频率取决于环境（headless/无绘制环境下
   * 可能远高于 60Hz，实测约 200Hz），合并窗口不可控；固定时间窗在任何环境行为一致。
   * （旧实现调用 mo.takeRecords() 后随即丢弃，并未起到任何合并作用。） */
  function scheduleRender() {
    if (pendingRender) return
    var delay = Math.max(0, 16 - (Date.now() - lastRenderAt))
    pendingRender = setTimeout(function () {
      pendingRender = 0
      lastRenderAt = Date.now()
      render() // React 重渲染后补回被冲掉的节点
      var sig = signature()
      if (sig !== W.lastKey) {
        W.lastKey = sig
        kick()
      }
    }, delay)
  }

  function start() {
    render()
    fetchTurns().then(scheduleNext)

    mo = new MutationObserver(scheduleRender)
    mo.observe(document.documentElement, { childList: true, subtree: true })

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        render()
        kick()
      }
    })

    var tries = 0
    var it = setInterval(function () {
      tries++
      render()
      if ((W.session && W.lastKey) || tries > 40) clearInterval(it)
    }, 250)

    W.lastKey = signature()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
