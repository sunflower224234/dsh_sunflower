// dsh-tts-voice — 设置持久化（宿主侧唯一真源）
//
// 为什么要有这个文件：旧实现把「开/关」同时放在浏览器 localStorage 与服务端内存 cfg.muted 两处，
// 且前端从不读服务端、服务端重启即重置 —— 于是用户点开关的意图会被悄悄覆盖。
// 现在改成：设置只存在这一个 JSON 文件里，浏览器每次轮询都读它，开关状态不再分叉。
//
// 纯 Node、无副作用地暴露 load/save/readSettings/updateSettings，方便单测。

import fs from 'node:fs'
import path from 'node:path'

/** 朗读模式：只读结论 / 最多 N 句 / 全文逐句。 */
export const READ_MODES = ['conclusion', 'maxSentences', 'all']

export const DEFAULTS = Object.freeze({
  enabled: true,
  volume: 1,
  voiceId: '',
  mode: 'conclusion',
  maxSentences: 3,
  speed: 1,
  enabledAt: 0,
})

/** 把任意输入收敛成合法设置；非法字段回落到默认值，不做抛错（设置文件要能被人工编辑）。 */
export function sanitize(raw, defaults = DEFAULTS) {
  const out = { ...defaults }
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) out.volume = Math.min(1, Math.max(0, raw.volume))
  if (typeof raw.voiceId === 'string') out.voiceId = raw.voiceId
  if (typeof raw.mode === 'string' && READ_MODES.includes(raw.mode)) out.mode = raw.mode
  if (typeof raw.maxSentences === 'number' && Number.isFinite(raw.maxSentences)) {
    out.maxSentences = Math.min(10, Math.max(1, Math.round(raw.maxSentences)))
  }
  if (typeof raw.speed === 'number' && Number.isFinite(raw.speed) && raw.speed > 0) {
    out.speed = Math.min(2, Math.max(0.5, raw.speed))
  }
  if (typeof raw.enabledAt === 'number' && Number.isFinite(raw.enabledAt)) out.enabledAt = Math.round(raw.enabledAt)
  return out
}

/**
 * 校验一次更新请求。与 sanitize 不同，这里对「显式给了非法值」要报错，而不是静默纠正，
 * 免得前端把拼错的字段当成写成功了。
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'body must be a JSON object' }
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'enabled':
        if (typeof v !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
        out.enabled = v
        break
      case 'volume':
        // t2 要求「非法值拒绝并返回错误」：越界就报错，不静默 clamp，
        // 否则前端把 5 当成写成功，屏上显示 100% 而实际是 1，又是一次两端分叉。
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          return { ok: false, error: 'volume must be a number 0..1' }
        }
        out.volume = v
        break
      case 'voiceId':
        if (typeof v !== 'string') return { ok: false, error: 'voiceId must be a string' }
        out.voiceId = v
        break
      case 'mode':
        if (typeof v !== 'string' || !READ_MODES.includes(v)) {
          return { ok: false, error: 'mode must be one of ' + READ_MODES.join(' | ') }
        }
        out.mode = v
        break
      case 'maxSentences': {
        if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 10) {
          return { ok: false, error: 'maxSentences must be an integer 1..10' }
        }
        out.maxSentences = v
        break
      }
      case 'speed':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 2) {
          return { ok: false, error: 'speed must be a number 0.5..2' }
        }
        out.speed = v
        break
      default:
        return { ok: false, error: 'unknown field: ' + k }
    }
  }
  return { ok: true, patch: out }
}

/** 读设置文件；不存在或损坏时返回 defaults（并保留损坏文件便于排查）。 */
export function load(file, defaults = DEFAULTS) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return { settings: sanitize(JSON.parse(text), defaults), source: 'file', corrupt: false }
  } catch (err) {
    const missing = err && err.code === 'ENOENT'
    if (!missing) {
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()) } catch (e) {}
    }
    return { settings: { ...defaults }, source: missing ? 'default' : 'corrupt', corrupt: !missing }
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 被读到。 */
export function save(file, settings) {
  const dir = path.dirname(file)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {}
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return settings
}
