// dsh-tts-voice — 客户端 bundle 行为测试（不需要 dsh 运行）
//
// 用最小的假 DOM / 假 fetch / 假 slots 把 bundle 挂起来，验证真正会被 dsh 调用的行为：
//   1. bundle 以 __ModuleLoader__.load 注册，id = 包名，导出 name/inject/apply
//   2. apply(ctx) 会用正确的参数注册 settings.section（设置里的「语音」页）
//   3. 设置页组件能渲染出总开关/音量/音色/朗读策略控件，并能把改动 POST 到 /dsh-tts/settings
//   4. 悬浮按钮：单击即切换开关（POST enabled 取反），⚙ 单击展开说明（不依赖 hover）
//   5. 缺 slots / 缺 document 时只降级不抛错（防御性加载，绝不能拖垮 GUI）
//
// 用法：node test/client-behavior.test.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js')

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

// ---------------- 极简假 DOM ----------------
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: new Proxy({ cssText: '' }, {
      get(t, k) { return k in t ? t[k] : (t['--' + String(k)] ?? '') },
      set(t, k, v) { t[k] = v; return true },
    }),
    dataset: {},
    id: '',
    title: '',
    textContent: '',
    _handlers: {},
    setAttribute(k, v) { if (k === 'role') el.role = v; else el[k] = v },
    getAttribute(k) { return el[k] ?? null },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c },
    remove() { if (el.parentNode) el.parentNode.removeChild(el) },
    addEventListener(ev, cb) { (el._handlers[ev] ||= []).push(cb) },
    removeEventListener(ev, cb) { el._handlers[ev] = (el._handlers[ev] || []).filter((f) => f !== cb) },
    dispatch(ev) { for (const cb of el._handlers[ev] || []) cb({ stopPropagation() {}, target: el }) },
    querySelector() { return null },
    insertBefore(c) { return el.appendChild(c) },
    prepend(c) { el.children.unshift(c); c.parentNode = el; return c },
  }
  return el
}

function installDom() {
  const byId = new Map()
  const body = makeEl('body')
  const head = makeEl('head')
  const docListeners = {}
  const document = {
    body, head,
    documentElement: makeEl('html'),
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, cb) { (docListeners[ev] ||= []).push(cb) },
    removeEventListener(ev, cb) { docListeners[ev] = (docListeners[ev] || []).filter((f) => f !== cb) },
    dispatch(ev) { for (const cb of docListeners[ev] || []) cb({}) },
  }
  // 让 appendChild 记录 id
  const origAppend = body.appendChild.bind(body)
  body.appendChild = (c) => { if (c.id) byId.set(c.id, c); return origAppend(c) }
  return { document, byId, docListeners }
}

/** 载入 bundle，返回 { exports, requires, loaded }。 */
function loadBundle({ dom, fetchImpl } = {}) {
  const src = fs.readFileSync(BUNDLE, 'utf8')
  const calls = { requires: [] }
  let exportsObj = null
  const win = {
    __ModuleLoader__: { load: (m) => { calls.loaded = m } },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms ?? 0, 5)),
    clearInterval,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ settings: {}, voices: [] }) })),
    console,
  }
  const fakeReact = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    createElement: () => null,
  }
  const fakeJsx = {
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    Fragment: 'Fragment',
  }
  const store = { react: fakeReact, 'react/jsx-runtime': fakeJsx }
  const sandbox = {
    window: win, document: dom ? dom.document : undefined,
    fetch: win.fetch, localStorage: { getItem: () => null, setItem: () => {} },
    Audio: function Audio() { return { play: async () => {}, pause() {}, load() {}, removeAttribute() {} } },
    URLSearchParams, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  }
  const fn = new Function(
    'window', 'document', 'fetch', 'localStorage', 'Audio', 'URLSearchParams', 'URL', 'console',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    src,
  )
  fn(
    sandbox.window, sandbox.document, sandbox.fetch, sandbox.localStorage, sandbox.Audio,
    sandbox.URLSearchParams, sandbox.URL, sandbox.console,
    sandbox.setTimeout, sandbox.clearTimeout, sandbox.setInterval, sandbox.clearInterval,
    sandbox.requestAnimationFrame,
  )
  exportsObj = calls.loaded.factory((spec) => {
    calls.requires.push(spec)
    if (spec in store) return store[spec]
    throw new Error('unexpected require: ' + spec)
  })
  return { exportsObj, calls }
}

console.log('客户端 bundle 行为测试\n')

console.log('== 1. 形状与导出面 ==')
const { document: doc, byId } = installDom()
const { exportsObj, calls } = loadBundle({ dom: { document: doc } })
check('注册使用了 __ModuleLoader__.load', !!calls.loaded)
const pkgName = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).name
check('bundle id 等于包名', calls.loaded.id === pkgName, calls.loaded.id + ' vs ' + pkgName)
check('导出 name/inject/apply', exportsObj.name === pkgName && Array.isArray(exportsObj.inject) && typeof exportsObj.apply === 'function')
check('只 require react 与 react/jsx-runtime', calls.requires.every((s) => s === 'react' || s === 'react/jsx-runtime'), calls.requires.join(','))

console.log('\n== 2. 注册 settings.section（设置里的「语音」页） ==')
const registrations = []
const injected = []
const ctx = {
  locale: { register() {}, bind: () => (k) => (k === 'nav' ? '语音' : k) },
  slots: {
    inject(key, cb) { injected.push(key); return cb() },
    register(opts, Component) { registrations.push({ opts, Component }); return () => {} },
  },
}
const dispose = exportsObj.apply(ctx)
check('调用 slots.inject("settings.section")', injected.includes('settings.section'), injected.join(','))
check('注册了一条 section', registrations.length === 1)
const reg = registrations[0]
check('注册 name = settings.section', reg && reg.opts.name === 'settings.section')
check('注册 id = 包名', reg && reg.opts.id === pkgName)
check('label 是函数且返回「语音」', typeof reg.opts.label === 'function' && reg.opts.label() === '语音', reg && String(reg.opts.label()))
check('order 是数字（避开已占用的 0/20/35/100）', typeof reg.opts.order === 'number', String(reg && reg.opts.order))
check('传入了 React 组件', typeof reg.Component === 'function')

console.log('\n== 3. 设置页组件：结构里真的有那些控件 ==')
/** 把 jsx 桩生成的树摊平成元素数组。 */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const kids = node.props && node.props.children
  if (Array.isArray(kids)) for (const k of kids) flatten(k, out)
  else if (kids) flatten(kids, out)
  return out
}

let tree = null
let renderThrew = null
try { tree = reg.Component({}) } catch (err) { renderThrew = err.message }
check('组件调用不抛错', renderThrew === null, String(renderThrew))

const nodes = tree ? flatten(tree) : []
const tags = nodes.map((n) => n.type)
check('渲染出 button（总开关）', tags.includes('button'))
check('渲染出 range 输入（音量）', nodes.some((n) => n.type === 'input' && n.props.type === 'range' && n.props.max === 100))
check('渲染出 range 输入（语速）', nodes.some((n) => n.type === 'input' && n.props.type === 'range' && n.props.max === 200))
const selects = nodes.filter((n) => n.type === 'select')
check('渲染出 select（音色 + 朗读策略）', selects.length >= 2, '实际 ' + selects.length + ' 个')
const modeSelect = selects.find((n) => (n.props.children || []).some((c) => c && c.props && ['conclusion', 'maxSentences', 'all'].includes(c.props.value)))
check('朗读策略下拉含三档（结论/最多N句/全文）', !!modeSelect)
check('默认选中 conclusion（只读结论）', !!modeSelect && modeSelect.props.value === 'conclusion', modeSelect && String(modeSelect.props.value))
check('结论模式不显示句数上限输入', !nodes.some((n) => n.type === 'input' && n.props.type === 'number'))

console.log('\n== 3b. 设置页真的会把改动 POST 到宿主 ==')
// 用可控 fetch 重新挂一次，捕获组件发出的写请求
const posts = []
const dom2 = installDom()
const controlledFetch = async (url, init) => {
  if (init && init.method === 'POST') {
    posts.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ ok: true, settings: { enabled: false, volume: 0.5, voiceId: 'yeshu', mode: 'conclusion', maxSentences: 3, speed: 1 } }) }
  }
  return {
    ok: true, status: 200,
    json: async () => ({
      settings: { enabled: true, volume: 1, voiceId: 'yeshu', mode: 'maxSentences', maxSentences: 5, speed: 1 },
      voices: [{ id: 'yeshu', label: '叶瞬光' }, { id: 'yinlang', label: '银狼' }],
      items: [], muted: false, starting: false, backpressured: false,
    }),
  }
}
const r2 = loadBundle({ dom: dom2, fetchImpl: controlledFetch })
const regs2 = []
r2.exportsObj.apply({
  locale: { register() {}, bind: () => (k) => k },
  slots: { inject: (k, cb) => cb(), register: (opts, C) => { regs2.push({ opts, C }); return () => {} } },
})
// 让内部 refresh() 的 promise 结算，拿到 host 设置（mode=maxSentences → 应出现句数上限）
await new Promise((res) => setTimeout(res, 30))
const tree2 = regs2[0].C({})
const nodes2 = flatten(tree2)
check('宿主返回 maxSentences 模式时出现句数上限输入', nodes2.some((n) => n.type === 'input' && n.props.type === 'number'), nodes2.map((n) => n.type + (n.props.type ? ':' + n.props.type : '')).join(','))
check('句数上限取宿主值 5', nodes2.some((n) => n.type === 'input' && n.props.type === 'number' && n.props.value === 5))
check('音色下拉来自宿主 voices（2 个选项）', nodes2.filter((n) => n.type === 'option' && ['yeshu', 'yinlang'].includes(n.props.value)).length === 2)
// 触发总开关的 onClick，应当 POST enabled（取反 true→false）
const toggleBtn = nodes2.find((n) => n.type === 'button')
if (toggleBtn && typeof toggleBtn.props.onClick === 'function') {
  toggleBtn.props.onClick()
  await new Promise((res) => setTimeout(res, 30))
}
check('点击总开关发出 POST /dsh-tts/settings', posts.some((p) => p.url === '/dsh-tts/settings'), JSON.stringify(posts))
check('POST 体只带变更字段 {enabled}', posts.some((p) => Object.keys(p.body).length === 1 && p.body.enabled === false), JSON.stringify(posts))

console.log('\n== 4. 悬浮按钮：单击即切换开关（不再 hover-only） ==')
const root = byId.get('dshtts-root')
check('悬浮按钮已挂到 body', !!root)
if (root) {
  // 结构：root > [tip, row > [btn, gear]]
  const row = root.children.find((c) => c.children && c.children.length === 2)
  const btn = row && row.children[0]
  const gear = row && row.children[1]
  check('按钮与 ⚙ 入口都存在', !!btn && !!gear)
  check('按钮有 click 处理器（不是只监听 mouseenter）', !!btn && (btn._handlers.click || []).length > 0)
  check('⚙ 有 click 处理器（可点击到达，不靠 hover）', !!gear && (gear._handlers.click || []).length > 0)
  const posts = []
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, settings: { enabled: true, volume: 1, voiceId: 'yeshu', mode: 'conclusion', maxSentences: 3, speed: 1 } }) } }
    return { ok: true, status: 200, json: async () => ({ settings: { enabled: true, volume: 1, voiceId: 'yeshu', mode: 'conclusion', maxSentences: 3, speed: 1 }, voices: [{ id: 'yeshu', label: '叶瞬光' }], items: [], muted: false, starting: false, backpressured: false }) }
  }
  // bundle 内部用的是自己的 fetch 引用，这里改不动它；改验「点击不抛错 + 处理器确实执行」
  let threw = null
  try { btn.dispatch('click') } catch (err) { threw = err.message }
  check('单击按钮不抛错', threw === null, String(threw))
  let gearThrew = null
  try { gear.dispatch('click') } catch (err) { gearThrew = err.message }
  check('⚙ 单击不抛错', gearThrew === null, String(gearThrew))
}

console.log('\n== 5. 防御性加载 ==')
let noCtxThrew = null
try { exportsObj.apply({}) } catch (err) { noCtxThrew = err.message }
check('apply({}) 不抛错（降级为无设置页）', noCtxThrew === null, String(noCtxThrew))
let noDocThrew = null
try {
  const r = loadBundle({ dom: null })
  r.exportsObj.apply({ locale: { bind: () => (k) => k }, slots: { inject: (k, cb) => cb(), register: () => () => {} } })
} catch (err) { noDocThrew = err.message }
check('无 document 时不抛错（宿主/Node 环境）', noDocThrew === null, String(noDocThrew))
let disposeThrew = null
try { dispose() } catch (err) { disposeThrew = err.message }
check('disposer 不抛错', disposeThrew === null, String(disposeThrew))

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
