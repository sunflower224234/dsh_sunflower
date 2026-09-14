// dsh-tts-voice — server-side host plugin.
//
// Hooks the live session/event stream. For every assistant `text-delta` chunk it
// accumulates text, splits it into complete sentences, forwards each sentence to the
// local GPT-SoVITS V2 API (http://127.0.0.1:9880/tts), and keeps the resulting WAV in
// memory for the injected client script to fetch and play. Code blocks and empty/odd
// fragments are skipped.
//
// Lifecycle: if the TTS server is not reachable it is auto-started (lazy, on first
// voice use) and, when DSH exits, the process the plugin spawned is stopped. A server
// the user started themselves is detected (already reachable) and never started/stopped
// by the plugin.
//
// Config (env, all optional):
//   DSH_TTS_URL       default http://127.0.0.1:9880/tts
//   DSH_TTS_REF       default F:/AI/GPT-SoVITS/reference-叶瞬光-生动.wav
//   DSH_TTS_PROMPT    default 哎，干嘛用这么担心的眼神看我？
//   DSH_TTS_LANG      default zh
//   DSH_TTS_SPEED     default 1.0
//
//   DSH_TTS_AUTOSTART 1 to auto-start the server when down (default 1); 0 to never start.
//   DSH_TTS_AUTOSTOP  1 to stop the spawned server when dsh exits (default 1); 0 to keep it.
//   DSH_TTS_DIR       GPT-SoVITS deployment dir (default F:/AI/GPT-SoVITS)
//   DSH_TTS_PY        python to spawn (default <dir>/.venv/Scripts/python.exe)
//   DSH_TTS_ENTRY     entry file (default api_v2.py)
//   DSH_TTS_CONFIG    config file (default GPT_SoVITS/configs/tts_infer-yeshunguang.yaml)
//   DSH_TTS_HOST      default 127.0.0.1
//   DSH_TTS_PORT      default 9880

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pickSentences, isProcessChunk, normalize } from './read-policy.js'
import * as settingsStore from './settings.js'

const name = 'dsh-tts-voice'
const inject = ['webServer']

// 客户端那一半由 dsh 的 boot 图加载（见 package.json 的 dsh.client + exports["./client"]），
// 宿主侧**不再注入任何页内脚本**：同一 id 注册两次会让 dsh-client-modules 在 boot 的
// create() 里抛 duplicate factory registration，直接导致整个 Web GUI 打不开。
// 旧客户端脚本 lib/tts.js 保留在仓库里，仅供回滚参考。

const TTS_DEFAULT = 'http://127.0.0.1:9880/tts'
const REF_DEFAULT = 'F:/AI/GPT-SoVITS/reference-叶瞬光-生动.wav'
const PROMPT_DEFAULT = '哎，干嘛用这么担心的眼神看我？'
const DIR_DEFAULT = 'F:/AI/GPT-SoVITS'
/** 设置文件：宿主侧唯一真源（默认放 GPT-SoVITS 目录，可用 DSH_TTS_STATE 覆盖）。 */
const STATE_FILE_DEFAULT = 'F:/AI/GPT-SoVITS/dsh-tts-voice.json'

/**
 * 反压阈值：前端不在听的时候不能无限合成。
 * 未消费音频超过 BACKPRESSURE_ITEMS 段或 BACKPRESSURE_BYTES 字节就暂停合成，
 * 等前端播完回调 /dsh-tts/consumed 把水位降下来再继续。
 */
const BACKPRESSURE_ITEMS = 12
const BACKPRESSURE_BYTES = 24 * 1024 * 1024
/** 未消费音频的存活时间：超过就丢，避免内存无界增长。 */
const UNCONSUMED_TTL_MS = 120000

// Approach A (pretrained base + reference cloning): each voice is just a reference
// audio clip + its transcript. Switching a voice = switching ref_audio_path/prompt_text.
// Keep the refs in F:/AI/GPT-SoVITS. Env overrides for the default voice still apply.
const VOICES = [
  { id: 'yeshu', label: '叶瞬光', ref: 'F:/AI/GPT-SoVITS/reference-叶瞬光-生动.wav', prompt: '哎，干嘛用这么担心的眼神看我？', lang: 'zh' },
  { id: 'yinlang', label: '银狼', ref: 'F:/AI/GPT-SoVITS/reference-银狼.wav', prompt: '这么快就上钩了？好像有点棘手。', lang: 'zh' },
]

// Sentence terminators (Chinese + a couple ASCII/ellipsis).
const TERMINATORS = '。！？…'

// If the accumulated buffer exceeds this without a sentence boundary, force-split on a
// soft separator so latency stays bounded (GPT-SoVITS handles each fragment well).
const MAX_BUFFER = 300
const SOFT_SEPARATORS = '，、；：,;:\n '

// How long to wait for a freshly-spawned server to become ready (model load).
const START_TIMEOUT_MS = 150000

/**
 * Split text into complete sentences (each ending in a terminator) plus the trailing
 * incomplete `rest`. Code-fence regions are kept intact so the caller can skip them.
 */
function extractSentences(text) {
  const complete = []
  let segStart = 0
  let i = 0
  let fence = false
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      fence = !fence
      i += 3
      continue
    }
    if (!fence && TERMINATORS.includes(text[i])) {
      let j = i
      while (j < text.length && TERMINATORS.includes(text[j])) j++
      if (text[j] === '\n') j++
      complete.push(text.slice(segStart, j))
      segStart = j
      i = j
      continue
    }
    i++
  }
  return { complete, rest: text.slice(segStart) }
}

/** Force-split a long run on soft separators so nothing exceeds ~max chars per call. */
function forceSplit(text, max) {
  const parts = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (buf.length >= max && SOFT_SEPARATORS.includes(ch)) {
      if (buf.trim().length > 0) parts.push(buf)
      buf = ''
    }
  }
  return { parts, tail: buf }
}

function speakable(seg) {
  if (!seg || typeof seg !== 'string') return false
  const s = seg.trim()
  if (s.length < 2) return false
  if (s.includes('```')) return false
  // must contain at least one CJK or Latin letter (skip pure punctuation / numbers)
  if (!/[\u4e00-\u9fff\u3400-\u4dbfA-Za-z]/.test(s)) return false
  return true
}

function apply(ctx) {
  const ttsHost = process.env.DSH_TTS_HOST || '127.0.0.1'
  const ttsPort = Number(process.env.DSH_TTS_PORT || '9880')
  const ttsUrl = process.env.DSH_TTS_URL || TTS_DEFAULT
  const dir = process.env.DSH_TTS_DIR || DIR_DEFAULT
  const stateFile = process.env.DSH_TTS_STATE || STATE_FILE_DEFAULT

  // ---- 设置：宿主侧文件是唯一真源（浏览器不再用 localStorage 当权威） ----
  const loaded = settingsStore.load(stateFile, {
    ...settingsStore.DEFAULTS,
    mode: /^(0|false)$/i.test(process.env.DSH_TTS_MODE_ALL || '') ? 'all' : settingsStore.DEFAULTS.mode,
    maxSentences: Number(process.env.DSH_TTS_MAX_SENTENCES) || settingsStore.DEFAULTS.maxSentences,
    speed: Number(process.env.DSH_TTS_SPEED) || settingsStore.DEFAULTS.speed,
    voiceId: process.env.DSH_TTS_VOICE || '',
    enabled: !/^(0|false)$/i.test(process.env.DSH_TTS_ENABLED || '1'),
  })
  let settings = loaded.settings
  function saveSettings() {
    try { settingsStore.save(stateFile, settings) } catch (err) { logSpawnLine('settings save failed: ' + err.message) }
  }

  const cfg = {
    ref: process.env.DSH_TTS_REF || REF_DEFAULT,
    prompt: process.env.DSH_TTS_PROMPT || PROMPT_DEFAULT,
    ttsUrl,
    host: ttsHost,
    port: ttsPort,
    lang: process.env.DSH_TTS_LANG || 'zh',
    autostart: !/^(0|false)$/i.test(process.env.DSH_TTS_AUTOSTART || '1'),
    autostop: !/^(0|false)$/i.test(process.env.DSH_TTS_AUTOSTOP || '1'),
    preload: !/^(0|false)$/i.test(process.env.DSH_TTS_PRELOAD || '1'),
    dir,
    stateFile,
    py: process.env.DSH_TTS_PY || path.join(dir, '.venv', 'Scripts', 'python.exe'),
    entry: process.env.DSH_TTS_ENTRY || 'api_v2.py',
    config: process.env.DSH_TTS_CONFIG || 'GPT_SoVITS/configs/tts_infer.yaml',
  }
  // 旧代码里到处用 cfg.muted / cfg.speed，这里用取值器接到新设置上，少改调用点
  Object.defineProperty(cfg, 'muted', { get: () => !settings.enabled })
  Object.defineProperty(cfg, 'speed', { get: () => settings.speed })

  // Approach A voice registry (copy so env overrides can touch the default voice).
  const voices = VOICES.map(v => ({ ...v }))
  if (process.env.DSH_TTS_REF) voices[0].ref = process.env.DSH_TTS_REF
  if (process.env.DSH_TTS_PROMPT !== undefined) voices[0].prompt = process.env.DSH_TTS_PROMPT
  if (process.env.DSH_TTS_LANG) voices[0].lang = process.env.DSH_TTS_LANG
  let activeVoiceId = voices.some(v => v.id === settings.voiceId) ? settings.voiceId
    : (voices.some(v => v.id === process.env.DSH_TTS_VOICE) ? process.env.DSH_TTS_VOICE : voices[0].id)
  // 把解析出来的音色写回设置，保证前端看到的就是服务端实际在用的
  settings.voiceId = activeVoiceId
  saveSettings()
  function currentVoice() {
    return voices.find(v => v.id === activeVoiceId) || voices[0]
  }

  let buffer = ''
  let lastDelta = '' // block-end 与 text-delta 会重复同一段文本，用它去重
  const store = new Map() // id -> { bytes, len, text, ts }
  // 音频 id 必须跨「插件重载 / 宿主重启」继续单调递增：浏览器记住的是「已经播过的最大 id」，
  // 计数器若在重启后从 1 重新开始，旧 cursor（id <= cursor 一律丢弃）会把新音频整批当成听过的，
  // 表现就是「重启后 / 静音解除后一段都不出声」。用时钟毫秒做种子（×1000 后仍远小于
  // Number.MAX_SAFE_INTEGER），并把 epoch 一起下发给前端，前端可在 epoch 变化时重置 cursor。
  const SERVER_EPOCH = Date.now()
  let idSeq = SERVER_EPOCH * 1000
  const pending = [] // queue of { text } awaiting synthesis
  let busy = false

  // ---- TTS server lifecycle ----
  let child = null
  let startedByPlugin = false
  let readyPromise = null
  let serverReady = false
  let reachableCache = null // { at, ok }
  const spawnLog = path.join(dir, 'dsh-tts-voice-spawn.log')

  function baseUrl() { return `http://${cfg.host}:${cfg.port}` }

  async function isReachable() {
    if (reachableCache && Date.now() - reachableCache.at < 3000) return reachableCache.ok
    let ok = false
    try {
      const r = await fetch(baseUrl() + '/docs', { method: 'GET', signal: AbortSignal.timeout(4000) })
      ok = r.status >= 200 && r.status < 500
    } catch (err) { ok = false }
    reachableCache = { at: Date.now(), ok }
    return ok
  }

  function logSpawnLine(line) {
    try {
      fs.appendFileSync(spawnLog, `[${new Date().toISOString()}] ${line}\n`)
    } catch (err) {}
  }

  function startTts() {
    return new Promise((resolve, reject) => {
      const args = [cfg.entry, '-a', cfg.host, '-p', String(cfg.port), '-c', cfg.config]
      let spawned
      try {
        spawned = spawn(cfg.py, args, { cwd: cfg.dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      } catch (err) {
        reject(err)
        return
      }
      child = spawned
      startedByPlugin = true
      logSpawnLine(`spawned ${cfg.py} ${args.join(' ')} (pid=${spawned.pid})`)
      spawned.stderr.setEncoding('utf8')
      spawned.stderr.on('data', (d) => { try { logSpawnLine(String(d).trim()) } catch (err) {} })
      spawned.on('error', (err) => { logSpawnLine('spawn error: ' + (err && err.message)) })

      const deadline = Date.now() + START_TIMEOUT_MS
      const timer = setInterval(async () => {
        let up = false
        try { up = await isReachable() } catch (err) {}
        if (up) {
          clearInterval(timer)
          logSpawnLine('server ready')
          resolve(true)
          return
        }
        if (spawned.exitCode !== null && spawned.exitCode !== 0) {
          clearInterval(timer)
          logSpawnLine('server exited early rc=' + spawned.exitCode)
          reject(new Error('tts exited rc=' + spawned.exitCode))
          return
        }
        if (Date.now() > deadline) {
          clearInterval(timer)
          logSpawnLine('server start timeout')
          reject(new Error('tts start timeout'))
        }
      }, 1500)
    })
  }

  async function ensureTts() {
    if (await isReachable()) { serverReady = true; return true }
    if (!cfg.autostart) return false
    if (!readyPromise) {
      readyPromise = startTts()
        .then((ok) => { serverReady = true; return ok })
        .catch((err) => { readyPromise = null; throw err })
    }
    return readyPromise
  }

  /** 语音是否处于关闭状态。 */
  function voiceIsOff() {
    return settings.enabled === false
  }

  /**
   * 停掉本插件拉起的 TTS 服务（用户在设置里关掉语音 / dsh 退出时调用）。
   * 只结束**本插件自己 spawn 的**进程：如果服务是用户自己起的（startedByPlugin=false），
   * 我们既不该也不能去杀它。autostop=false 时同样尊重用户意愿不杀。
   */
  function stopTts(reason, { force = false } = {}) {
    if (!startedByPlugin) return false
    if (!force && !cfg.autostop) return false
    if (!child || child.exitCode !== null) { child = null; serverReady = false; return false }
    try {
      logSpawnLine(`stopping tts (${reason}) pid=${child.pid}`)
      child.kill()
    } catch (err) {
      logSpawnLine('stop tts failed: ' + (err && err.message))
    }
    child = null
    serverReady = false
    // 让下一次需要时重新拉起
    readyPromise = null
    reachableCache = null
    clearAll()
    return true
  }

  const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

  /** 读请求体（带上限，避免畸形请求把内存打爆）。 */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (d) => {
        size += d.length
        if (size > limit) { reject(new Error('body too large')); try { req.destroy() } catch (err) {} return }
        chunks.push(d)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function prune() {
    // store 里只有「还没被前端取走」的音频（播完会调 /dsh-tts/consumed 删除），
    // 所以这里就是未消费音频的存活上限：超时即丢弃，避免内存无界增长。
    const cutoff = Date.now() - UNCONSUMED_TTL_MS
    for (const [id, it] of store) {
      if (it.ts < cutoff) store.delete(id)
    }
    while (store.size > 80) {
      let minId = Infinity
      let minKey = null
      for (const k of store.keys()) if (k < minId) { minId = k; minKey = k }
      if (minKey === null) break
      store.delete(minKey)
    }
  }

  function clearAll() {
    store.clear()
    pending.length = 0
    buffer = ''
    // 关键：id 必须继续单调递增。旧实现在这里把 idSeq 也归零，而前端用「id <= cursor 就算听过」
    // 过滤，于是静音解除后新音频的 id 又从小数字开始，被前端整批当成旧的丢掉 —— 表现就是
    // 「关掉再打开以后一段都不出声」。store 清空已足够，idSeq 不动。
  }

  /** 未消费音频的总字节数（反压判据）。 */
  function unconsumedBytes() {
    let n = 0
    for (const it of store.values()) n += it.len
    return n
  }

  /** 前端不在听的时候不要无限合成：队列里没消费掉的音频超过阈值就暂停。 */
  function backpressured() {
    return pending.length >= BACKPRESSURE_ITEMS || unconsumedBytes() >= BACKPRESSURE_BYTES
  }

  async function synthesize(text) {
    const v = currentVoice()
    const body = {
      text,
      text_lang: v.lang,
      ref_audio_path: v.ref,
      prompt_text: v.prompt,
      prompt_lang: v.lang,
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      speed_factor: cfg.speed,
    }
    try {
      if (!(await ensureTts())) return null
      const res = await fetch(cfg.ttsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) return null
      const ab = await res.arrayBuffer()
      if (!ab || ab.byteLength < 200) return null
      return Buffer.from(ab)
    } catch (err) {
      return null
    }
  }

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (pending.length > 0 && !cfg.muted) {
        // 反压：前端一直不来取（页面没开/没在听）就停下，别空烧 GPU 和内存
        if (backpressured()) break
        const item = pending.shift()
        const bytes = await synthesize(item.text)
        if (bytes && !cfg.muted) {
          const id = ++idSeq
          store.set(id, { bytes, len: bytes.byteLength, text: item.text, ts: Date.now() })
        }
      }
    } finally {
      busy = false
    }
  }

  // 朗读策略改为「整轮结束再决定念什么」：
  //   - 流式期间只累积正文，不逐句合成（旧实现边收边念，导致过程话、半截句都被念出来）；
  //   - 收到本轮的 block-end（承载整段最终文本）或 turn/end 时，用 read-policy 选句。
  // 这样「只读结论要点 / 最多 N 句 / 全文」三档才能真正生效。
  function handleDelta(text) {
    if (cfg.muted || !text) return
    if (text === lastDelta) return // block-end 会重发同一段文本，去重避免念两遍
    lastDelta = text
    buffer += text
    if (buffer.length > MAX_BUFFER) {
      // 兜底：极端长文本时保留尾部，避免无界增长
      buffer = buffer.slice(-MAX_BUFFER)
    }
  }

  /** 用朗读策略把本轮累积的正文变成待合成句子。 */
  function flushTurn() {
    const text = buffer.trim()
    buffer = ''
    lastDelta = ''
    if (!text || cfg.muted) return
    let sentences = []
    try {
      sentences = pickSentences(text, { mode: settings.mode, maxSentences: settings.maxSentences })
    } catch (err) {
      logSpawnLine('read-policy failed, falling back to raw split: ' + (err && err.message))
      sentences = extractSentences(normalize(text)).complete.map((s) => s.trim()).filter(speakable)
    }
    let added = false
    for (const s of sentences) {
      if (!speakable(s)) continue
      pending.push({ text: s })
      added = true
    }
    if (added) pump()
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return
    const type = event.type
    if (type === 'turn/end') { flushTurn(); return }
    // 事件层白名单：reasoning / 工具调用 / 工具结果 / 状态提示一律不读
    if (isProcessChunk(event)) return
    const chunk = event.data && event.data.chunk
    if (!chunk) return
    if (chunk.type === 'text-delta') handleDelta(chunk.text || '')
    else if (chunk.type === 'block-end' && typeof chunk.text === 'string') handleDelta(chunk.text)
  }

  /**
   * 统一的设置写入路径：校验后的 patch → 收敛 → 落盘 → 生效副作用。
   * /dsh-tts/settings、/dsh-tts/mute、/dsh-tts/voice 三个入口都走这里，
   * 避免出现「某个入口只改了内存、另一个入口才落盘」这种分叉。
   */
  function applySettingsPatch(patch) {
    const previousEnabled = settings.enabled
    const next = settingsStore.sanitize({ ...settings, ...patch })
    if (next.enabled !== settings.enabled) next.enabledAt = Date.now()
    if (next.voiceId && voices.some(v => v.id === next.voiceId)) activeVoiceId = next.voiceId
    settings = next
    saveSettings()
    // 只在「状态真的翻转」时做副作用
    const turnedOn = settings.enabled && !previousEnabled
    const turnedOff = !settings.enabled && previousEnabled
    if (turnedOff) {
      clearAll()                 // 关闭即停止：清队列与未消费音频
      stopTts('voice disabled')  // 并把模型进程停掉，不让它继续占显存
    } else if (turnedOn) {
      // 打开时现拉模型（首次要等加载完；前端会显示「模型加载中…」）
      ensureTts().catch((err) => logSpawnLine('warmup on enable failed: ' + (err && err.message)))
    } else if (settings.enabled) {
      pump()
    }
    return settings
  }

  const disposers = []

  disposers.push(ctx.on('session/event', (session, event) => {
    try { onEvent(event) } catch (err) {}
  }))

  // ---- routes (same-origin; no CORS needed for the browser) ----

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/state',
    handler: (req, res) => {
      prune()
      const items = []
      for (const [id, it] of store) {
        items.push({ id, len: it.len, ts: it.ts })
      }
      items.sort((a, b) => a.id - b.id)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        muted: cfg.muted,
        starting: !serverReady && child !== null && child.exitCode === null,
        // 宿主进程标识：前端发现 epoch 变了就重置 cursor（配合上面的单调 id 双保险）
        epoch: SERVER_EPOCH,
        items,
        // 设置一并下发：前端每次轮询都能对齐宿主侧真源，不再出现两端分叉
        settings,
        voices: voices.map(v => ({ id: v.id, label: v.label })),
        backpressured: backpressured(),
      }))
    },
  }))

  // 设置读写：宿主侧文件是唯一真源。GET 读，POST 局部更新（原子写）。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/settings',
    handler: async (req, res) => {
      try {
        if (!req.method || req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            settings,
            voices: voices.map(v => ({ id: v.id, label: v.label })),
            modes: settingsStore.READ_MODES,
            file: stateFile,
          }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const raw = await readBody(req, 64 * 1024)
        let patch
        try { patch = JSON.parse(raw || '{}') } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
          return
        }
        const checked = settingsStore.validatePatch(patch)
        if (!checked.ok) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: checked.error }))
          return
        }
        const result = applySettingsPatch(checked.patch)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, settings: result }))
      } catch (err) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/audio',
    handler: (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams
      const id = Number(q.get('id'))
      const it = store.get(id)
      if (!it) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no audio')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        'Content-Length': String(it.len),
      })
      res.end(it.bytes)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/consumed',
    handler: (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams
      const id = Number(q.get('id'))
      if (Number.isFinite(id)) store.delete(id)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true }))
    },
  }))

  // 兼容旧入口：改为写同一份设置（设置文件才是真源），不再动内存态
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/mute',
    handler: (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams
      const on = String(q.get('on') || '')
      if (on === '1' || on === 'true') applySettingsPatch({ enabled: false })
      else if (on === '0' || on === 'false') applySettingsPatch({ enabled: true })
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ muted: cfg.muted, settings }))
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-tts/voice',
    handler: (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams
      const set = q.get('set')
      if (set && voices.some(x => x.id === set)) applySettingsPatch({ voiceId: set })
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        active: activeVoiceId,
        voices: voices.map(v => ({ id: v.id, label: v.label, lang: v.lang })),
      }))
    },
  }))

  // 注意：**不要再往页面里注入客户端脚本**。
  // 本插件已声明 dsh.client + exports["./client"]，客户端 bundle 由 dsh 的 boot 图经
  // /plugins/dsh-tts-voice/client.js 加载；页内再注入一份会让同一个 id 注册两次，
  // 而 dsh-client-modules 的 register() 对重复注册是显式抛错（且发生在 boot 的 create() 里），
  // 结果是整个 Web GUI 打不开。旧客户端脚本 lib/tts.js 仍留在仓库里，需要回滚时用它。


  // 预热：让语音随叫随到 —— 但**只在语音是开着的时候**。
  // 关着的时候把一个几 GB 的模型常驻显存/内存、白占 GPU，没有意义；
  // 等用户在设置里打开语音时 ensureTts() 会现拉（首次要等模型加载，日志里有记录）。
  if (cfg.preload && !voiceIsOff()) {
    ensureTts().catch(() => {})
  } else {
    logSpawnLine(voiceIsOff() ? 'voice is off at startup -> skip model preload' : 'preload disabled (DSH_TTS_PRELOAD=0)')
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
    // Stop the server only if this plugin spawned it and autostop is enabled.
    if (startedByPlugin && cfg.autostop && child && child.exitCode === null) {
      try {
        logSpawnLine('dsh exiting -> killing tts pid=' + child.pid)
        child.kill()
      } catch (err) {}
    }
  })
}

export { name, inject, apply }
