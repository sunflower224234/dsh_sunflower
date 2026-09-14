// 回归测试：dsh-im-readonly 的群聊判定与权限施加。
// 用真实的 QQ state 文件结构（临时目录造样例），桩掉 permission 服务。
//
// 运行：node test/group-gate.mjs      （退出码 0 = 通过）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('F:/AI/dsh-im-readonly/lib/index.js').href)
const { isGroupSession, buildStores } = mod

let failures = 0
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label) }
  catch (err) { failures += 1; console.log('  FAIL ' + label + ' -> ' + err.message) }
}

// ---- 造一个仿真的 dsh-im 绑定文件 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imro-'))
const storeFile = path.join(dir, 'state.json')
const GROUP_SESSION = 'session-group-1111'
const DIRECT_SESSION = 'session-direct-2222'
fs.writeFileSync(storeFile, JSON.stringify({
  version: 1,
  sessions: {
    'group:AAAA-BBBB-CCCC': GROUP_SESSION,
    'c2c:819D8C448F8F9C59AFAFFCEE576719E3': DIRECT_SESSION,
  },
  seenMessageIds: [],
}), 'utf8')

const stores = buildStores({ stores: [{ id: 'qq', file: storeFile }] })
assert.equal(stores.length, 1)

console.log('== isGroupSession（真实文件结构）==')
check('群聊会话识别为 true', () => assert.equal(isGroupSession(stores, GROUP_SESSION), true))
check('单聊会话识别为 false', () => assert.equal(isGroupSession(stores, DIRECT_SESSION), false))
check('未知会话识别为 null', () => assert.equal(isGroupSession(stores, 'session-unknown'), null))
check('空 id 识别为 null', () => assert.equal(isGroupSession(stores, ''), null))

console.log('')
console.log('== mtime 缓存 ==')
check('同一 mtime 复用缓存', () => {
  const before = stores[0].state
  isGroupSession(stores, GROUP_SESSION)
  assert.equal(stores[0].state, before)
})
check('文件变化后重读（新增群）', () => {
  const NEW_GROUP = 'session-group-3333'
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    sessions: {
      'group:AAAA-BBBB-CCCC': GROUP_SESSION,
      'c2c:819D8C448F8F9C59AFAFFCEE576719E3': DIRECT_SESSION,
      'group:DDDD-EEEE': NEW_GROUP,
    },
    seenMessageIds: [],
  }), 'utf8')
  // 显式推进 mtime，避免同一毫秒内写入导致 statSync 看起来没变
  const future = Date.now() / 1000 + 5
  fs.utimesSync(storeFile, future, future)
  assert.equal(isGroupSession(stores, NEW_GROUP), true)
})
check('文件缺失时返回 null', () => {
  const gone = buildStores({ stores: [{ id: 'x', file: path.join(dir, 'nope.json') }] })
  assert.equal(isGroupSession(gone, GROUP_SESSION), null)
})

// ---- 端到端：桩 permission 服务，走 apply() ----
console.log('')
console.log('== apply() 端到端 ==')

function makeCtx() {
  const applied = []
  const listeners = []
  // 贴近真实：会话在 session/created 时已被 pinInitialPermission 钉上部署默认预设，
  // 所以 current() 一开始就返回 'danger-full-access'，而不是 null。
  const DEFAULT_PRESET = 'danger-full-access'
  const permission = {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    current(session) { return session.__preset ?? DEFAULT_PRESET },
    set(session, name) { session.__preset = name; applied.push({ id: session.id, name }) },
  }
  const ctx = {
    get: (n) => (n === 'permission' || n === 'permissionPresets' ? permission : undefined),
    on: (event, cb) => { listeners.push({ event, cb }) },
    effect: (fn) => fn(),
  }
  return { ctx, applied, listeners, permission }
}

function sessionWith(id, agentPreset) {
  return { id, header: { agentPreset } }
}

const CONFIG = {
  readOnlyPreset: 'read-only',
  unresolved: 'read-only',
  stores: [{ id: 'qq', file: storeFile }],
}

let t = makeCtx()
mod.apply(t.ctx, CONFIG)
check('注册了 session/created 监听', () => {
  assert.equal(t.listeners.filter((l) => l.event === 'session/created').length, 1)
})
const fire = (env, session) => {
  for (const l of env.listeners) if (l.event === 'session/created') l.cb(session)
}

const groupSession = sessionWith(GROUP_SESSION, 'qq-yinlang')
fire(t, groupSession)
check('群聊会话被设为 read-only', () => {
  assert.equal(t.applied.length, 1)
  assert.equal(t.applied[0].name, 'read-only')
})

fire(t, sessionWith(DIRECT_SESSION, 'qq-yinlang'))
check('单聊会话不被改动（保持完全访问）', () => {
  assert.equal(t.applied.length, 1, '单聊不应触发任何 set')
})

fire(t, sessionWith('session-unknown', 'qq-yinlang'))
check('无法归类 -> 按 unresolved=read-only 锁上', () => {
  assert.equal(t.applied.length, 2)
  assert.equal(t.applied[1].id, 'session-unknown')
})

fire(t, groupSession)
check('同一会话已是 read-only 时不重复写', () => {
  assert.equal(t.applied.length, 2)
})
check('已是 read-only 的会话（模拟重启后重放）也不重复写', () => {
  const already = sessionWith(GROUP_SESSION, 'qq-yinlang')
  already.__preset = 'read-only'
  fire(t, already)
  assert.equal(t.applied.length, 2)
})

const subEnv = makeCtx()
mod.apply(subEnv.ctx, CONFIG)
const sub = { id: GROUP_SESSION, header: { agentPreset: 'qq-yinlang', origin: 'subagent', delegationDepth: 1 } }
fire(subEnv, sub)
check('子代理默认不锁', () => assert.equal(subEnv.applied.length, 0))

const allowEnv = makeCtx()
mod.apply(allowEnv.ctx, { ...CONFIG, unresolved: 'allow' })
fire(allowEnv, sessionWith('session-unknown', 'qq-yinlang'))
check('unresolved=allow 时无法归类的会话保持不动', () => assert.equal(allowEnv.applied.length, 0))
fire(allowEnv, sessionWith(GROUP_SESSION, 'qq-yinlang'))
check('unresolved=allow 时群聊仍被锁', () => assert.equal(allowEnv.applied.length, 1))

const offEnv = makeCtx()
mod.apply(offEnv.ctx, { ...CONFIG, enabled: false })
check('enabled=false 时不注册监听', () => assert.equal(offEnv.listeners.length, 0))

const badEnv = makeCtx()
badEnv.permission.names = ['workspace-write']
mod.apply(badEnv.ctx, CONFIG)
check('预设不存在时不注册监听（不静默失效）', () => assert.equal(badEnv.listeners.length, 0))

fs.rmSync(dir, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
