// dsh-tts-voice — 客户端 bundle 在真实 DOM（jsdom）里的行为测试
//
// 比 test/client-behavior.test.mjs 更进一步：用 jsdom 提供真实 DOM，用一个可驱动状态更新的
// 最小 React 实现（useState/useEffect/react-dom createRoot）把组件真正挂载到页面上，
// 然后用 DOM 事件驱动交互，断言：
//   - 设置页真的渲染出控件
//   - 改朗读策略 → 句数上限出现
//   - 点总开关 / 拖动滑杆 / 切音色 → 真的发出 POST /dsh-tts/settings，且只带变更字段
//   - 悬浮按钮渲染、单击切换开关、⚙ 单击展开说明（非 hover-only）
//
// 用法：node test/client-dom.test.mjs   （需要 jsdom；缺失时自动跳过并 exit 0）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js')

let JSDOM
try { ({ JSDOM } = await import('jsdom')) } catch (err) {
  console.log('跳过：未安装 jsdom（npm install --no-save jsdom）')
  process.exit(0)
}

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

// ---------------- 可驱动的极简 React ----------------
function createReact(document) {
  let current = null
  const hooksOf = (inst) => { current = inst; return inst.hooks }

  function useState(init) {
    const inst = current
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => { inst.hooks[i] = typeof v === 'function' ? v(inst.hooks[i]) : v; scheduleRender(inst) }
    return [inst.hooks[i], set]
  }
  function useEffect(fn, deps) {
    const inst = current
    const i = inst.cursor++
    const prev = inst.effects[i]
    const changed = !prev || !deps || deps.some((d, k) => d !== prev.deps[k])
    if (changed) {
      prev && prev.cleanup && prev.cleanup()
      inst.effects[i] = { deps, cleanup: fn() }
    }
  }
  function useRef(v) {
    const inst = current
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: v }
    return inst.hooks[i]
  }

  const dirty = new Set()
  let flushTimer = null
  function scheduleRender(inst) {
    dirty.add(inst)
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      for (const it of dirty) rerender(it)
      dirty.clear()
    }, 0)
  }
  async function flush() { await new Promise((r) => setTimeout(r, 5)) }

  /**
   * 重新渲染：像 React 一样**替换**容器里的旧树（而不是再 append 一份），
   * 否则旧 DOM 会残留、断言会读到过期节点。
   */
  function rerender(inst) {
    if (!inst.mounted) return render(inst)
    const next = render(inst)
    const parent = inst.mounted.parentNode
    if (parent && next && next.nodeType) parent.replaceChild(next, inst.mounted)
    inst.mounted = next
    return next
  }

  function createElement(type, props, ...children) {
    if (typeof type === 'function') {
      const inst = { type, hooks: [], cursor: 0, effects: [], children }
      const flat = children.flat().filter((c) => c !== null && c !== undefined && c !== false)
      const node = render(inst, props || {}, flat)
      if (node && node.nodeType) node.__inst = inst // 供 mount 记录挂载点
      return node
    }
    const el = document.createElement(type)
    const p = props || {}
    for (const [k, v] of Object.entries(p)) {
      if (k === 'children' || v === null || v === undefined) continue
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'value') el.value = String(v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else el.setAttribute(k, String(v))
    }
    // children 可能来自位置参数，也可能写在 props.children 里（我的 bundle 用的是后者）
    const kids = []
    if (p.children !== undefined && p.children !== null) kids.push(p.children)
    kids.push(...children)
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue
      el.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)))
    }
    return el
  }

  function render(inst, props = inst.lastProps || {}, children) {
    if (props) inst.lastProps = props
    const prev = current
    current = inst          // 关键：渲染期间把 current 指向本实例，hooks 才能落到它身上
    inst.cursor = 0
    let body
    try {
      body = inst.type({ ...inst.lastProps, children })
    } finally {
      inst.node = body
      current = prev
    }
    return body
  }

  /**
   * 挂载到真实容器：渲染一次并记录挂载点，之后 setState 触发的重渲染会原地替换。
   */
  function mount(container, element) {
    const inst = element && element.__inst
    container.appendChild(element)
    if (inst) inst.mounted = element
    return element
  }

  return { useState, useEffect, useRef, createElement, flush, mount, _instances: () => dirty }
}

// ---------------- 加载 bundle ----------------
function loadBundle(window, document, fetchImpl) {
  const src = fs.readFileSync(BUNDLE, 'utf8')
  let registration = null
  window.__ModuleLoader__ = { load: (m) => { registration = m }, create: () => {} }
  const react = createReact(document)
  const jsx = { jsx: react.createElement, jsxs: react.createElement, Fragment: 'Fragment' }
  const reqs = []
  const requireStub = (spec) => {
    reqs.push(spec)
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return jsx
    throw new Error('unexpected require: ' + spec)
  }
  const fn = new Function(
    'window', 'document', 'fetch', 'localStorage', 'Audio', 'URLSearchParams', 'URL', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    src,
  )
  fn(window, document, fetchImpl, window.localStorage, window.Audio, URLSearchParams, URL, console,
    setTimeout, clearTimeout, setInterval, clearInterval, (cb) => setTimeout(cb, 0))
  const plugin = registration.factory(requireStub)
  return { plugin, react, reqs, id: registration.id }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('客户端 bundle 真实 DOM（jsdom）行为测试\n')

const posts = []
const host = { enabled: true, mode: 'conclusion', volume: 1, voiceId: 'yeshu', maxSentences: 3, speed: 1 }

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="panel"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
const { window } = dom
const document = window.document

const fetchImpl = async (url, init) => {
  const u = String(url)
  if (u.startsWith('/dsh-tts/settings')) {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}')
      posts.push(body)
      Object.assign(host, body)
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: { ...host } }) }
    }
    return { ok: true, status: 200, json: async () => ({ settings: { ...host }, voices: [{ id: 'yeshu', label: '叶瞬光' }, { id: 'yinlang', label: '银狼' }], modes: ['conclusion', 'maxSentences', 'all'] }) }
  }
  if (u.startsWith('/dsh-tts/state')) {
    return { ok: true, status: 200, json: async () => ({ muted: !host.enabled, starting: false, items: [], backpressured: false, settings: { ...host }, voices: [{ id: 'yeshu', label: '叶瞬光' }, { id: 'yinlang', label: '银狼' }] }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}
window.fetch = fetchImpl

const { plugin, react, reqs, id } = loadBundle(window, document, fetchImpl)

console.log('== 1. bundle 身份 ==')
const pkgName = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).name
check('bundle id = 包名', id === pkgName, id)
check('只 require react / react/jsx-runtime', reqs.every((s) => s === 'react' || s === 'react/jsx-runtime'), reqs.join(','))

console.log('\n== 2. apply 注册设置页并渲染到真实 DOM ==')
let Section = null
let regOpts = null
const ctx = {
  locale: { register() {}, bind: () => (k) => (k === 'nav' ? '语音' : k) },
  slots: { inject: (k, cb) => cb(), register: (opts, C) => { regOpts = opts; Section = C; return () => {} } },
}
plugin.apply(ctx)
check('section 注册成功', !!Section && regOpts.id === pkgName)
check('label 返回「语音」', regOpts.label() === '语音', regOpts.label())

const panel = document.getElementById('panel')
react.mount(panel, react.createElement(Section, {}))
await react.flush()
await sleep(60)
await react.flush()

const q = (sel) => panel.querySelectorAll(sel)
const txt = () => panel.textContent || ''
check('渲染出总开关按钮', q('button').length > 0, String(q('button').length))
check('渲染出两个滑杆（音量/语速）', q('input[type=range]').length >= 2, String(q('input[type=range]').length))
check('渲染出两个下拉（音色/策略）', q('select').length >= 2, String(q('select').length))
const modeOpts = [...q('option')].map((o) => o.value)
check('策略三档齐全', ['conclusion', 'maxSentences', 'all'].every((v) => modeOpts.includes(v)), modeOpts.join(','))
check('标题显示「语音朗读」', /语音朗读/.test(txt()))
check('音色选项来自宿主（叶瞬光/银狼）', /叶瞬光/.test(txt()) && /银狼/.test(txt()))
check('结论模式默认不显示句数上限', q('input[type=number]').length === 0)

console.log('\n== 3. DOM 交互 → 真的发出 POST（只带变更字段） ==')
const btn = [...q('button')].find((b) => /已开启|已关闭/.test(b.textContent))
check('找到总开关按钮', !!btn, btn && btn.textContent)
const n0 = posts.length
btn.dispatchEvent(new window.Event('click', { bubbles: true }))
await sleep(80); await react.flush()
check('点击总开关 POST {enabled:false}', posts.slice(n0).some((p) => p.enabled === false && Object.keys(p).length === 1), JSON.stringify(posts.slice(n0)))
check('页面状态随之变为「已关闭」', /已关闭/.test(txt()), txt().slice(0, 80))

// 切朗读策略 → 应出现句数上限并 POST mode
const selects = [...q('select')]
const modeSel = selects.find((s) => [...s.options].some((o) => o.value === 'maxSentences'))
const n1 = posts.length
modeSel.value = 'maxSentences'
modeSel.dispatchEvent(new window.Event('change', { bubbles: true }))
await sleep(80); await react.flush()
check('切换策略 POST {mode:maxSentences}', posts.slice(n1).some((p) => p.mode === 'maxSentences'), JSON.stringify(posts.slice(n1)))
check('切到「最多 N 句」后出现句数上限输入', q('input[type=number]').length === 1, String(q('input[type=number]').length))
check('句数上限取宿主值 3', q('input[type=number]')[0] && q('input[type=number]')[0].value === '3')

// 改句数上限
const numInput = q('input[type=number]')[0]
const n2 = posts.length
numInput.value = '5'
numInput.dispatchEvent(new window.Event('change', { bubbles: true }))
await sleep(80); await react.flush()
check('改句数上限 POST {maxSentences:5}', posts.slice(n2).some((p) => p.maxSentences === 5), JSON.stringify(posts.slice(n2)))

// 音量滑杆
const ranges = [...q('input[type=range]')]
const volRange = ranges.find((r) => r.max === '100')
const n3 = posts.length
volRange.value = '40'
volRange.dispatchEvent(new window.Event('change', { bubbles: true }))
await sleep(80); await react.flush()
check('拖音量滑杆 POST {volume:0.4}', posts.slice(n3).some((p) => p.volume === 0.4), JSON.stringify(posts.slice(n3)))

// 音色
const voiceSel = [...q('select')].find((s) => [...s.options].some((o) => o.value === 'yinlang'))
const n4 = posts.length
voiceSel.value = 'yinlang'
voiceSel.dispatchEvent(new window.Event('change', { bubbles: true }))
await sleep(80); await react.flush()
check('切音色 POST {voiceId:yinlang}', posts.slice(n4).some((p) => p.voiceId === 'yinlang'), JSON.stringify(posts.slice(n4)))

console.log('\n== 4. 悬浮按钮（真实 DOM） ==')
const pill = document.getElementById('dshtts-root')
check('悬浮按钮已挂载到 body', !!pill)
if (pill) {
  const text0 = pill.textContent
  check('显示状态文本（含「语音」）', /语音/.test(text0), text0)
  const clickable = [...pill.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer')
  check('按钮 + 齿轮两个可点击元素', clickable.length >= 2, String(clickable.length))
  const hasHoverOnly = [...pill.querySelectorAll('div')].every((d) => !d.onmouseenter)
  check('不依赖 hover 才能用（无 mouseenter 才可见的元素）', hasHoverOnly)
  const n5 = posts.length
  clickable[0].dispatchEvent(new window.Event('click', { bubbles: true }))
  await sleep(120)
  check('单击悬浮按钮发出 POST（取反）', posts.slice(n5).length > 0 && typeof posts.slice(n5)[0].enabled === 'boolean', JSON.stringify(posts.slice(n5)))
  const gear = clickable[1]
  const tipBefore = pill.firstElementChild.style.display
  gear.dispatchEvent(new window.Event('click', { bubbles: true }))
  await sleep(30)
  check('⚙ 单击切换说明面板显示', pill.firstElementChild.style.display !== tipBefore, tipBefore + ' -> ' + pill.firstElementChild.style.display)
}

console.log('\n== 5. 防御性加载 ==')
let threw = null
try { plugin.apply({}) } catch (err) { threw = err.message }
check('apply({}) 不抛错（降级）', threw === null, String(threw))

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
dom.window.close()
process.exit(failed ? 1 : 0)
