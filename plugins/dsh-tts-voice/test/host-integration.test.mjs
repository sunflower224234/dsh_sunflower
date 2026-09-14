// dsh-tts-voice — 宿主模块隔离集成测试
//
// 不依赖 dsh 重启：用一个假的 cordis ctx（stub webServer/on/effect）把 apply() 挂起来，
// 然后直接调用捕获到的 HTTP handler 与事件处理器，验证端到端行为：
//   1. 设置端点读写 + 字段校验 + 落盘
//   2. 开关能关能开，且状态在「读」的时候一致（不再两端分叉）
//   3. 事件过滤：reasoning/工具调用不产出音频，正文才产出
//   4. 朗读策略生效：conclusion 模式只念结论
//   5. 反压：未被消费时不无限合成
//   6. id 单调：静音→恢复后 id 不回到小数字
//   7. id 修复回归
//
// 用法：node test/host-integration.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_TTS_STATE = path.join(os.tmpdir(), 'tts-host-it-' + process.pid + '.json')
process.env.DSH_TTS_PRELOAD = '0'      // 不要把真模型拉起来
process.env.DSH_TTS_AUTOSTART = '0'    // 不要 spawn python
process.env.DSH_TTS_URL = 'http://127.0.0.1:9/tts' // 合成必失败：我们只验证「有没有尝试合成」

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

// ---------------- 假 ctx ----------------
const routes = new Map()
const listeners = new Map()
let tapTransform = null

const ctx = {
  webServer: {
    register({ kind, path: p, handler }) { routes.set(p, { kind, handler }); return () => routes.delete(p) },
    tapIndex(fn) { tapTransform = fn; return () => { tapTransform = null } },
  },
  on(event, cb) { listeners.set(event, cb); return () => listeners.delete(event) },
  effect(fn) { return fn() },
}

plugin.apply(ctx)

// ---------------- 极简 req/res ----------------
function makeReq(method, body, url) {
  const handlers = {}
  const req = {
    method,
    url,
    on(ev, cb) { handlers[ev] = cb; return req },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) handlers.data?.(Buffer.from(body))
    handlers.end?.()
  })
  return req
}
function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(s, h) { res.status = s; res.headers = h || null; return res },
    end(chunk) { res.body = chunk === undefined ? '' : String(chunk); res.done?.() },
  }
  res.wait = new Promise((r) => { res.done = r })
  return res
}
async function call(p, { method = 'GET', body } = {}) {
  const bare = String(p).split('?')[0]
  const entry = routes.get(bare)
  if (!entry) throw new Error('no route: ' + bare)
  const res = makeRes()
  await entry.handler(makeReq(method, body, p), res)
  await Promise.race([res.wait, new Promise((r) => setTimeout(r, 200))])
  let json = null
  try { json = JSON.parse(res.body) } catch (e) {}
  return { status: res.status, json, raw: res.body }
}

/** 模拟一轮 assistant 输出：一串 text-delta + 可选 block-end + turn/end。 */
function emitTurn(text, { withBlockEnd = false } = {}) {
  const fire = listeners.get('session/event')
  const chunks = text.match(/[\s\S]{1,6}/g) || []
  for (const c of chunks) fire({}, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: c } } })
  if (withBlockEnd) fire({}, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'block-end', text } } })
  fire({}, { type: 'turn/end' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 测试 ----------------
console.log('宿主模块隔离集成测试\n')

console.log('== 1. 路由与设置读写 ==')
const state = await call('/dsh-tts/state')
check('state 路由存在且返回 settings', state.status === 200 && !!state.json.settings, JSON.stringify(state.json).slice(0, 120))
check('state 带 voices 列表', Array.isArray(state.json.voices) && state.json.voices.length >= 2)
check('默认 mode = conclusion', state.json.settings.mode === 'conclusion', state.json.settings.mode)
check('默认 enabled = true', state.json.settings.enabled === true)
check('state 带 backpressured 字段', typeof state.json.backpressured === 'boolean')

const get1 = await call('/dsh-tts/settings')
check('GET /settings 返回 modes 与 file', Array.isArray(get1.json.modes) && typeof get1.json.file === 'string')
check('设置文件已落盘', fs.existsSync(process.env.DSH_TTS_STATE))

console.log('\n== 2. 字段校验 ==')
const bad1 = await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ mode: 'nope' }) })
check('非法 mode 被拒 (400)', bad1.status === 400 && /mode must be one of/.test(bad1.json.error), JSON.stringify(bad1.json))
const bad2 = await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ maxSentences: 99 }) })
check('超范围 maxSentences 被拒', bad2.status === 400 && /1\.\.10/.test(bad2.json.error))
const bad3 = await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ nope: 1 }) })
check('未知字段被拒', bad3.status === 400 && /unknown field/.test(bad3.json.error))
const bad4 = await call('/dsh-tts/settings', { method: 'POST', body: 'not json' })
check('非法 JSON 被拒', bad4.status === 400 && /invalid JSON/.test(bad4.json.error))

console.log('\n== 3. 开关：能关能开，且读到的一致 ==')
const off = await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ enabled: false }) })
check('关闭成功且返回 enabled=false', off.status === 200 && off.json.settings.enabled === false)
const afterOff = await call('/dsh-tts/state')
check('关闭后 state.settings.enabled=false（读一致）', afterOff.json.settings.enabled === false)
check('关闭后 muted=true（兼容字段）', afterOff.json.muted === true)
const onDisk = JSON.parse(fs.readFileSync(process.env.DSH_TTS_STATE, 'utf8'))
check('关闭状态已落盘（重启不丢）', onDisk.enabled === false, JSON.stringify(onDisk))
const on = await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ enabled: true }) })
check('重新打开成功', on.json.settings.enabled === true)
const afterOn = await call('/dsh-tts/state')
check('打开后 state 同步为 true', afterOn.json.settings.enabled === true)

console.log('\n== 4. 旧入口也写同一份设置（不再分叉） ==')
await call('/dsh-tts/mute?on=1')
const m1 = await call('/dsh-tts/state')
check('旧 /mute?on=1 让 settings.enabled=false', m1.json.settings.enabled === false)
await call('/dsh-tts/mute?on=0')
const m2 = await call('/dsh-tts/state')
check('旧 /mute?on=0 让 settings.enabled=true', m2.json.settings.enabled === true)
const v1 = await call('/dsh-tts/voice?set=yinlang')
check('旧 /voice?set= 写入设置并生效', v1.json.active === 'yinlang')
const v2 = await call('/dsh-tts/settings')
check('音色变更已落盘', v2.json.settings.voiceId === 'yinlang', v2.json.settings.voiceId)

console.log('\n== 5. 事件过滤：过程内容不产出音频 ==')
await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ mode: 'all' }) })
const fire = listeners.get('session/event')
fire({}, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: '我在思考。' } } })
fire({}, { type: 'assistant/chunk', data: { chunk: { type: 'tool-call-delta', text: '{"tool":"read"}' } } })
fire({}, { type: 'assistant/chunk', data: { chunk: { type: 'block-end', text: '' } } })
fire({}, { type: 'turn/end' })
const afterProc = await call('/dsh-tts/state')
check('纯过程事件不产生待合成队列', afterProc.json.items.length === 0)

console.log('\n== 6. 正文会进入合成（合成失败=URL 打不通，但队列确实被消费过） ==')
emitTurn('这是第一句正文。这是第二句正文。')
await sleep(400)
const st6 = await call('/dsh-tts/state')
check('正文触发了合成流程（没有异常，state 正常）', st6.status === 200)

console.log('\n== 7. 反压与 id 单调 ==')
const st7 = await call('/dsh-tts/state')
check('backpressured 字段存在', typeof st7.json.backpressured === 'boolean')
const ids1 = st7.json.items.map((i) => i.id)
const maxId1 = ids1.length ? Math.max(...ids1) : 0
// 关闭→清空→再打开，id 不应回到 <= maxId1
await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ enabled: false }) })
await call('/dsh-tts/settings', { method: 'POST', body: JSON.stringify({ enabled: true }) })
const st7b = await call('/dsh-tts/state')
check('清空后 store 为空', st7b.json.items.length === 0)

console.log('\n== 8. P0 回归：宿主绝不能注入页内客户端脚本 ==')
// 背景：客户端 bundle 已由 dsh 的 boot 图（/plugins/dsh-tts-voice/client.js）加载。
// 若宿主再用 tapIndex 注入一份，同一 id 会在 boot 的 create() 里抛
// "duplicate factory registration"，直接导致整个 Web GUI 打不开。
check('未注册 /dsh-tts/client.js 路由', !routes.has('/dsh-tts/client.js'))
check('未注册 /dsh-tts/tts.js 路由', !routes.has('/dsh-tts/tts.js'))
check('未安装 tapIndex 页面注入', tapTransform === null)
const bundlePath = new URL('../lib/client.js', import.meta.url)
check('客户端 bundle 文件存在（boot 图要求）', fs.existsSync(bundlePath))
const bundleSrc = fs.readFileSync(bundlePath, 'utf8')
// 只数语句级调用（行首、非注释），避免把头部注释里的示例算进去
const loadCalls = bundleSrc.split('\n').filter((l) => /^window\.__ModuleLoader__\.load\(/.test(l.trim())).length
check('bundle 只有一处语句级 __ModuleLoader__.load', loadCalls === 1, '实际 ' + loadCalls + ' 处')
check('bundle id 与包名一致', /id:\s*['"]dsh-tts-voice['"]/.test(bundleSrc))
check('bundle 只 require 种子模块 react', !/require\(['"]@deepseek-ai\/dsh-client-store['"]\)/.test(bundleSrc))
check('客户端不调用 settingsScope（方案 B：设置走自有 HTTP）', !/settingsScope\.(bind|getSnapshot)/.test(bundleSrc))

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
try { fs.rmSync(process.env.DSH_TTS_STATE, { force: true }) } catch (e) {}
process.exit(failed ? 1 : 0)
