// 回归测试：确认本插件与 deepseek-harness-zh_pro 的 assemble 包装链能共存。
//
// 背景（2026-09-11 实测事故）：zh_pro 也包装 `systemPrompt.assemble`，其重入路径
// `ensureAssemblePatch` 会把实例属性复位到原型方法以甩掉历史包装。那个复位在本
// 插件存在时会连带绕掉人格注入层，导致 QQ 机器人在被追问时退回部署自带口吻
// （"DeepSeek Harness 上跑的 AI agent，住在 Web GUI 127.0.0.1:3080"）。
//
// 本测试同时覆盖两个方向：
//   A) zh_pro 先包装、本插件后包装（真实加载顺序），且 zh_pro 多次重入
//   B) 本插件先包装、zh_pro 后包装
// 并验证网页会话（standard 预设）仍拿到叶瞬光、且 harness 段落保留。
//
// 运行：node test/zh-pro-chain.mjs        （退出码 0 = 通过）
//
// 依赖：本插件所在 profile 的 node_modules 里有 deepseek-harness-zh_pro。
// 路径可用环境变量覆盖，默认按本机布局。
import { existsSync } from 'node:fs'

const ZH_PRO = process.env.ZH_PRO_ASSEMBLE_PATCH
  || 'C:/Users/35756/.dsh/profiles/web/node_modules/deepseek-harness-zh_pro/lib/assemble-patch.js'
const SELF = new URL('../lib/index.js', import.meta.url).href

if (!existsSync(ZH_PRO)) {
  console.log('SKIP: 找不到 deepseek-harness-zh_pro 的 assemble-patch.js -> ' + ZH_PRO)
  process.exit(0)
}

const { ensureAssemblePatch } = await import('file:///' + ZH_PRO)
const personaMod = await import(SELF)

function makeAssembly() {
  return {
    sections: [
      { name: 'harness:identity', order: -100, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'harness:source', order: -90, text: 'The DeepSeek Harness implementation checkout is at C:\\x' },
      { name: 'deployment:persona-prefix', order: 0, text: '[QQ 银狼人设占位符]' },
      { name: 'app:web-surface', order: 100, text: 'You are interacting with the user through the DeepSeek Web GUI at http://127.0.0.1:3080.' },
      { name: 'deployment:persona-suffix', order: 10200, text: 'Your working directory is F:\\MyCode\\dsh-desktop.' },
    ],
  }
}
class Sys { async assemble() { return makeAssembly() } }

const CONFIG = {
  personas: [
    { id: 'default', file: 'F:/AI/data/叶瞬光人设提示词-精简版.md' },
    { id: 'qq', role: 'qq', presetIds: ['qq-yinlang'], suppressSections: ['harness:identity', 'harness:source', 'app:web-surface'], since: '>=0.1.5' },
  ],
}

const effects = []
const svc = new Sys()
const ctx = { get: (n) => (n === 'systemPrompt' ? svc : undefined), effect: (fn, l) => { const d = fn(); effects.push({ l, d }); return d } }

/** 逐层描述链。 */
function chain(f) {
  const out = []
  let cur = f
  const proto = Sys.prototype.assemble
  let guard = 0
  while (typeof cur === 'function' && guard < 10) {
    const tags = []
    if (cur === proto) tags.push('PROTO')
    if (cur.__dshZhAssembleWrapped === true) tags.push('zh')
    if (cur.__dshPersonaAssembleWrapped === true) tags.push('persona')
    if (tags.length === 0) tags.push('plain')
    out.push(tags.join('+'))
    cur = cur.__dshZhAssembleInner !== undefined
      ? cur.__dshZhAssembleInner
      : (cur.__dshPersonaAssembleInner !== undefined ? cur.__dshPersonaAssembleInner : null)
    guard += 1
  }
  return out.join(' -> ')
}

const agentQQ = { agent: { session: { header: { agentPreset: 'qq-yinlang' } } } }
async function state(label) {
  const out = await svc.assemble(agentQQ)
  const all = out.sections.map((s) => s.text).join('\n')
  const names = out.sections.map((s) => s.name)
  const ok = all.includes('你是银狼') && !all.includes('占位符')
  console.log('  ' + label + '  -> ' + (ok ? 'OK' : 'FAIL'))
  console.log('     链: ' + chain(svc.assemble))
  console.log('     人设=' + all.includes('你是银狼') + ' 占位符=' + all.includes('占位符')
    + ' identity=' + names.includes('harness:identity') + ' webSurface=' + names.includes('app:web-surface'))
  return ok
}

console.log('=== zh_pro 先，人格插件后（真实加载顺序）===')
ensureAssemblePatch(ctx, svc)
console.log('  zh_pro 首次: ' + chain(svc.assemble))
personaMod.apply(ctx, CONFIG)
const r1 = await state('A1 人格插件包装后')

console.log('')
console.log('=== zh_pro 重入（真实存在的第二处调用点）===')
ensureAssemblePatch(ctx, svc)
const r2 = await state('A2 zh_pro 重入后')

console.log('')
ensureAssemblePatch(ctx, svc)
const r3 = await state('A3 再重入一次')

console.log('')
console.log('=== 反向：人格插件先，zh_pro 后 ===')
const svc2 = new Sys()
const ctx2 = { get: (n) => (n === 'systemPrompt' ? svc2 : undefined), effect: (fn) => fn() }
personaMod.apply(ctx2, CONFIG)
ensureAssemblePatch(ctx2, svc2)
const out2 = await svc2.assemble(agentQQ)
const all2 = out2.sections.map((s) => s.text).join('\n')
const r4 = all2.includes('你是银狼') && !all2.includes('占位符')
console.log('  B1 -> ' + (r4 ? 'OK' : 'FAIL') + '  链: ' + chain(svc2.assemble))

console.log('')
console.log('=== 网页会话（standard 预设）应仍是叶瞬光，且 harness 段落保留 ===')
const webOut = await svc.assemble({ agent: { session: { header: { agentPreset: 'standard' } } } })
const webAll = webOut.sections.map((s) => s.text).join('\n')
const webNames = webOut.sections.map((s) => s.name)
const r5 = webAll.includes('叶瞬光') && webNames.includes('harness:identity') && webNames.includes('app:web-surface')
console.log('  Web -> ' + (r5 ? 'OK' : 'FAIL') + '  叶瞬光=' + webAll.includes('叶瞬光')
  + ' identity=' + webNames.includes('harness:identity') + ' webSurface=' + webNames.includes('app:web-surface'))

console.log('')
const pass = r1 && r2 && r3 && r4 && r5
console.log(pass ? '全部通过' : '仍有失败')
process.exit(pass ? 0 : 1)

