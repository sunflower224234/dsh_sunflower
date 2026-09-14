// dsh-tts-voice — 客户端插件（dsh 客户端 bundle）
//
// 形状要求（宿主 @deepseek-ai/dsh-client-modules 约定）：经典脚本，执行时只注册 factory，
// 所有副作用都发生在 materialization（factory 被调用）之后。
//
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... return module.exports } })
//
// 设计取舍（刻意的）：
//   1) 只 require shell 播种的模块（react / react/jsx-runtime），因此 dsh.client.external 可以为空，
//      少一个「specifier 没注册」的启动期失败面。
//   2) 设置的真源是宿主侧文件（lib/settings.js），客户端只用本插件自己的 HTTP 接口读写
//      （/dsh-tts/settings、/dsh-tts/state），**不依赖 settingsScope 能否写未知命名空间**。
//   3) 全程 try/catch：任何一步失败都只 console.warn 并退化为「只有悬浮按钮」，
//      绝不把异常冒泡进 dsh 自己的 UI。
window.__ModuleLoader__.load({
  id: 'dsh-tts-voice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    const NS = 'dsh-tts-voice'
    const STATE_URL = '/dsh-tts/state'
    const SETTINGS_URL = '/dsh-tts/settings'
    const AUDIO_URL = '/dsh-tts/audio'
    const CONSUMED_URL = '/dsh-tts/consumed'
    const POLL_MS = 400

    /** 当前设置快照（模块级：设置页与悬浮按钮共用）。 */
    let current = {
      settings: { enabled: true, volume: 1, voiceId: '', mode: 'conclusion', maxSentences: 3, speed: 1 },
      voices: [],
      starting: false,
      backpressured: false,
      loaded: false,
      error: null,
    }
    const listeners = new Set()
    function emit() { for (const fn of listeners) { try { fn() } catch (e) {} } }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

    async function refresh() {
      try {
        const res = await fetch(STATE_URL, { cache: 'no-store' })
        if (!res.ok) throw new Error('state HTTP ' + res.status)
        const data = await res.json()
        current = {
          settings: data.settings || current.settings,
          voices: data.voices || current.voices,
          starting: !!data.starting,
          backpressured: !!data.backpressured,
          loaded: true,
          error: null,
        }
      } catch (err) {
        current = { ...current, error: err && err.message ? err.message : String(err) }
      }
      emit()
      return current
    }

    /** 写设置：局部 patch。失败时不吞掉，交给调用方展示。 */
    async function patchSettings(patch) {
      const res = await fetch(SETTINGS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        cache: 'no-store',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || ('HTTP ' + res.status))
      }
      current = { ...current, settings: data.settings, loaded: true, error: null }
      emit()
      return data.settings
    }

    // ---------------- 播放器（按 id 顺序拉音频播放） ----------------
    const player = {
      cursor: 0,
      fetched: new Set(),
      queue: [],
      playing: false,
      audio: null,
      initialized: false,
    }

    function playNext() {
      const st = current.settings
      if (player.playing || !st.enabled || player.queue.length === 0) return
      const id = player.queue.shift()
      player.playing = true
      if (!player.audio) player.audio = new Audio()
      try { player.audio.volume = Math.min(1, Math.max(0, Number(st.volume))) } catch (e) {}
      const done = () => {
        player.playing = false
        if (id > player.cursor) player.cursor = id
        try { fetch(CONSUMED_URL + '?id=' + id, { cache: 'no-store' }) } catch (e) {}
        setTimeout(playNext, 40)
      }
      player.audio.onended = done
      player.audio.onerror = done
      player.audio.src = AUDIO_URL + '?id=' + id
      player.audio.play().catch(done)
    }

    function stopPlayback() {
      player.queue = []
      player.fetched.clear()
      if (player.audio) {
        try { player.audio.pause(); player.audio.removeAttribute('src'); player.audio.load() } catch (e) {}
      }
      player.playing = false
    }

    async function poll() {
      const st = await refresh()
      if (!st.settings.enabled) { stopPlayback(); return }
      if (!st.loaded) return
      let items
      try {
        const res = await fetch(STATE_URL, { cache: 'no-store' })
        items = (await res.json()).items || []
      } catch (err) { return }
      items.sort((a, b) => a.id - b.id)
      if (!player.initialized) {
        // 只播页面加载之后产生的音频，不回放历史
        player.initialized = true
        if (items.length) player.cursor = items[items.length - 1].id
        return
      }
      for (const it of items) {
        if (it.id <= player.cursor || player.fetched.has(it.id)) continue
        player.fetched.add(it.id)
        player.queue.push(it.id)
      }
      playNext()
    }

    // ---------------- 样式（宿主 CSP 拦 <style> 标签，所以逐条写内联样式） ----------------
    const S = {
      panel: {
        display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: 'inherit',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      label: { fontSize: '13px', opacity: '0.85' },
      hint: { fontSize: '12px', opacity: '0.55', lineHeight: '1.5' },
      pill: {
        padding: '5px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '999px',
        border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit',
      },
      field: {
        background: 'rgba(128,128,128,0.12)', color: 'inherit', border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: '8px', padding: '4px 8px', fontSize: '13px', minWidth: '96px',
      },
      error: { fontSize: '12px', color: '#ff6b6b' },
    }

    function Button(props) {
      const { on, onClick, children } = props
      const style = { ...S.pill, ...(on ? { background: 'rgba(76,155,255,0.22)', borderColor: 'rgba(76,155,255,0.6)' } : {}) }
      return jsxRuntime.jsx('button', { type: 'button', style, onClick, children })
    }

    function VoiceSettings() {
      const [, force] = react.useState(0)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)

      react.useEffect(() => {
        refresh()
        const off = subscribe(() => force((n) => n + 1))
        const timer = setInterval(refresh, 3000)
        return () => { off(); clearInterval(timer) }
      }, [])

      const st = current.settings
      const apply = (patch) => {
        setBusy(true); setErr(null)
        patchSettings(patch)
          .catch((e) => setErr(e && e.message ? e.message : String(e)))
          .finally(() => setBusy(false))
      }

      return jsxRuntime.jsxs('div', { style: S.panel, children: [
        jsxRuntime.jsxs('div', { style: S.row, children: [
          jsxRuntime.jsxs('div', { children: [
            jsxRuntime.jsx('div', { style: { fontSize: '14px', fontWeight: 600 }, children: '语音朗读' }),
            jsxRuntime.jsx('div', { style: S.hint, children: current.starting ? '语音模型加载中…' : (st.enabled ? '开：回复会按下面的策略朗读' : '关：不朗读，也不会合成音频') }),
          ] }),
          Button({ on: st.enabled, onClick: () => apply({ enabled: !st.enabled }), children: st.enabled ? '已开启' : '已关闭' }),
        ] }),

        jsxRuntime.jsxs('div', { style: S.row, children: [
          jsxRuntime.jsx('span', { style: S.label, children: '音量' }),
          jsxRuntime.jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [
            jsxRuntime.jsx('input', {
              type: 'range', min: 0, max: 100, step: 5, value: Math.round(st.volume * 100),
              style: { width: '160px', accentColor: '#4c9bff' },
              onChange: (e) => apply({ volume: Number(e.target.value) / 100 }),
            }),
            jsxRuntime.jsx('span', { style: { ...S.label, minWidth: '38px', textAlign: 'right' }, children: Math.round(st.volume * 100) + '%' }),
          ] }),
        ] }),

        jsxRuntime.jsxs('div', { style: S.row, children: [
          jsxRuntime.jsx('span', { style: S.label, children: '音色' }),
          jsxRuntime.jsx('select', {
            style: S.field, value: st.voiceId || '',
            onChange: (e) => apply({ voiceId: e.target.value }),
            children: (current.voices.length ? current.voices : [{ id: st.voiceId, label: st.voiceId || '(默认)' }])
              .map((v) => jsxRuntime.jsx('option', { value: v.id, children: v.label }, v.id)),
          }),
        ] }),

        jsxRuntime.jsxs('div', { style: S.row, children: [
          jsxRuntime.jsx('span', { style: S.label, children: '朗读策略' }),
          jsxRuntime.jsx('select', {
            style: S.field, value: st.mode,
            onChange: (e) => apply({ mode: e.target.value }),
            children: [
              jsxRuntime.jsx('option', { value: 'conclusion', children: '只读结论要点' }, 'conclusion'),
              jsxRuntime.jsx('option', { value: 'maxSentences', children: '最多 N 句' }, 'maxSentences'),
              jsxRuntime.jsx('option', { value: 'all', children: '全文逐句' }, 'all'),
            ],
          }),
        ] }),

        st.mode === 'maxSentences'
          ? jsxRuntime.jsxs('div', { style: S.row, children: [
              jsxRuntime.jsx('span', { style: S.label, children: '句数上限' }),
              jsxRuntime.jsx('input', {
                type: 'number', min: 1, max: 10, value: st.maxSentences, style: { ...S.field, minWidth: '64px' },
                onChange: (e) => {
                  const n = Number(e.target.value)
                  if (Number.isInteger(n) && n >= 1 && n <= 10) apply({ maxSentences: n })
                },
              }),
            ] })
          : null,

        jsxRuntime.jsxs('div', { style: S.row, children: [
          jsxRuntime.jsx('span', { style: S.label, children: '语速' }),
          jsxRuntime.jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [
            jsxRuntime.jsx('input', {
              type: 'range', min: 50, max: 200, step: 5, value: Math.round(st.speed * 100),
              style: { width: '160px', accentColor: '#4c9bff' },
              onChange: (e) => apply({ speed: Number(e.target.value) / 100 }),
            }),
            jsxRuntime.jsx('span', { style: { ...S.label, minWidth: '38px', textAlign: 'right' }, children: st.speed.toFixed(2) + '×' }),
          ] }),
        ] }),

        busy ? jsxRuntime.jsx('div', { style: S.hint, children: '保存中…' }) : null,
        err ? jsxRuntime.jsx('div', { style: S.error, children: '保存失败：' + err }) : null,
        current.error ? jsxRuntime.jsx('div', { style: S.error, children: '无法连接语音服务：' + current.error }) : null,
        current.backpressured ? jsxRuntime.jsx('div', { style: S.hint, children: '当前积压较多：页面没在播放时会自动暂停合成。' }) : null,
        jsxRuntime.jsx('div', { style: S.hint, children: '设置保存在宿主侧的 dsh-tts-voice.json，重启 dsh 后依然生效。' }),
      ] })
    }

    // ---------------- 悬浮按钮（单击开关；设置入口可点击） ----------------
    function mountFloating() {
      if (document.getElementById('dshtts-root')) return () => {}
      const root = document.createElement('div')
      root.id = 'dshtts-root'
      root.style.cssText = 'position:fixed;left:16px;bottom:92px;z-index:2147483000;display:flex;' +
        'flex-direction:column;align-items:flex-start;gap:6px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none'

      const btn = document.createElement('div')
      btn.setAttribute('role', 'button')
      btn.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:13px;cursor:pointer;' +
        'border-radius:999px;background:rgba(22,22,26,0.85);color:#e8e8ea;border:1px solid rgba(255,255,255,0.14);' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.35);backdrop-filter:blur(4px)'
      const label = document.createElement('span')
      btn.appendChild(label)

      // 齿轮：点击打开说明/入口（不再依赖 hover）
      const gear = document.createElement('div')
      gear.setAttribute('role', 'button')
      gear.title = '语音设置'
      gear.textContent = '⚙'
      gear.style.cssText = 'cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(22,22,26,0.85);' +
        'color:#e8e8ea;border:1px solid rgba(255,255,255,0.14);font-size:13px;line-height:1'
      const tip = document.createElement('div')
      tip.style.cssText = 'display:none;max-width:230px;background:rgba(22,22,26,0.94);color:#e8e8ea;border:1px solid rgba(255,255,255,0.14);' +
        'border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5'

      const render = () => {
        const st = current.settings
        label.textContent = st.enabled
          ? (current.starting ? '🔊 模型加载中…' : '🔊 语音 开')
          : '🔇 语音 关'
        tip.textContent = st.enabled
          ? '在「设置 → 语音」里可以调音量、音色与朗读策略（只读结论 / 最多 N 句 / 全文）。'
          : '语音已关闭。点左侧按钮可重新开启，或在「设置 → 语音」里细调。'
      }

      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        try {
          await patchSettings({ enabled: !current.settings.enabled })
          if (!current.settings.enabled) stopPlayback(); else playNext()
        } catch (err) {
          label.textContent = '🔇 切换失败'
        }
        render()
      })
      gear.addEventListener('click', (ev) => {
        ev.stopPropagation()
        tip.style.display = tip.style.display === 'none' ? 'block' : 'none'
      })

      root.appendChild(tip)
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px'
      row.appendChild(btn)
      row.appendChild(gear)
      root.appendChild(row)
      document.body.appendChild(root)

      const off = subscribe(render)
      render()
      const timer = setInterval(refresh, POLL_MS)
      return () => {
        off(); clearInterval(timer)
        try { root.remove() } catch (e) {}
      }
    }

    // ---------------- cordis 插件面 ----------------
    const name = NS
    const inject = ['slots', 'locale']

    /**
     * 防御性 apply：任何一步失败都只警告并继续降级，绝不打断 dsh 自身的 UI。
     */
    function apply(ctx) {
      const disposers = []
      try { refresh() } catch (e) {}

      // 1) 悬浮按钮（最基础的可用性，先装它）
      try {
        const stopFloating = mountFloating()
        disposers.push(stopFloating)
      } catch (err) {
        console.warn('[dsh-tts-voice] 悬浮按钮挂载失败：', err)
      }

      // 2) 设置里的「语音」页
      try {
        if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.locale.register(NS, {
              zh: { nav: '语音' },
              en: { nav: 'Voice' },
            })
          } catch (e) {}
        }
        const slots = ctx && ctx.slots
        if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          const label = () => {
            try { return ctx.locale.bind(NS)('nav') } catch (e) { return '语音' }
          }
          const dispose = slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: NS,
            order: 36,
            label,
            locale: NS,
            // 契约要求 inject 返回对象（它会作为 props 摊给组件）。返回函数是错形状；
            // 我们不依赖注入面，给空对象即可。
            inject: () => ({}),
          }, VoiceSettings))
          if (typeof dispose === 'function') disposers.push(dispose)
        } else {
          console.warn('[dsh-tts-voice] 宿主未提供 slots 服务，跳过设置页注册（悬浮按钮仍可用）')
        }
      } catch (err) {
        console.warn('[dsh-tts-voice] 设置页注册失败：', err)
      }

      // 3) 首次用户交互后解锁浏览器自动播放
      const unlock = () => { playNext() }
      try {
        document.addEventListener('pointerdown', unlock, { once: true })
        document.addEventListener('keydown', unlock, { once: true })
        disposers.push(() => {
          document.removeEventListener('pointerdown', unlock)
          document.removeEventListener('keydown', unlock)
        })
      } catch (e) {}

      return () => {
        for (const d of disposers.splice(0)) { try { d() } catch (e) {} }
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
