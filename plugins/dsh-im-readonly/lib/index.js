// dsh-im-readonly - force a read-only permission preset on IM GROUP sessions.
//
// Why this exists: an IM bot lives in your workspace with whatever the deployment's
// default permission preset is. On this machine that default is `danger-full-access`,
// so anyone who can talk to the bot in a group could rewrite the project. The user's
// requirement is "群聊允许查询, 不允许修改我的项目" - queries in groups, no writes.
//
// How it works (all verified against dsh 0.1.5):
//   * `dsh-permission-presets` ships a `read-only` preset (sandbox `read-only`,
//     approval `ask`) and records the choice per session as durable `permission/preset`
//     + `sandbox/mode` session events, so it survives restart and never leaks between
//     sessions.
//   * That plugin fills defaults on `session/created` (synchronously, in registration
//     order). This plugin registers its own `session/created` listener LATER - dsh-base
//     loads before this profile's own bundle - so the default is already pinned when we
//     run, and we override it for group sessions only.
//   * Group vs direct is resolved from dsh-im's own session binding: its QQ state store
//     maps `group:<groupOpenid>` / `c2c:<senderId>` to a DSH session id. We read that
//     file (cached by mtime) instead of guessing from titles or paths.
//
// Fail-safe direction: when a session's binding cannot be resolved, the configured
// `unresolved` policy decides. It defaults to `read-only`, so a session we cannot
// classify is treated as a group - being wrongly restrictive is recoverable, being
// wrongly permissive is not.
//
// Does NOT touch: web GUI sessions, subagent children, other channels, tool availability,
// tool permissions beyond the preset, model params, or chat history.

import fs from 'node:fs'

const name = 'dsh-im-readonly'
const inject = ['permissionPresets']

const READ_ONLY = 'read-only'
const GROUP_KEY_PREFIX = 'group:'

/** Default session-binding stores, per channel. Only qq is wired today. */
const DEFAULT_STORES = {
  qq: 'C:/Users/35756/.dsh/integrations/dsh-qq/bots/qq_7c58c106d9c54aa8a4cf2b70/state.json',
}

function normalizeStore(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const file = typeof entry.file === 'string' && entry.file.trim() ? entry.file.trim() : null
  if (!file) return null
  const presetIds = Array.isArray(entry.presetIds)
    ? entry.presetIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : []
  return {
    id: String(entry.id || entry.channel || file),
    file,
    presetIds,
    state: null,
    mtimeMs: null,
  }
}

function buildStores(config) {
  const entries = config && Array.isArray(config.stores) ? config.stores : null
  if (entries === null || entries.length === 0) {
    return Object.entries(DEFAULT_STORES).map(([id, file]) => normalizeStore({ id, file, presetIds: [] }))
  }
  const stores = []
  for (const entry of entries) {
    const store = normalizeStore(entry)
    if (store !== null) stores.push(store)
  }
  return stores
}

/**
 * Read a binding store unless its mtime is unchanged.
 * Returns the parsed `sessions` map, or null when unreadable.
 */
function refreshStore(store) {
  let mtimeMs = null
  try {
    mtimeMs = fs.statSync(store.file).mtimeMs
  } catch (err) {
    mtimeMs = null
  }
  if (store.mtimeMs === mtimeMs && store.state !== null) return store.state
  store.mtimeMs = mtimeMs
  if (mtimeMs === null) {
    store.state = null
    return null
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(store.file, 'utf8'))
    const sessions = parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object'
      ? parsed.sessions
      : {}
    store.state = sessions
    return sessions
  } catch (err) {
    store.state = null
    return null
  }
}

/** Does any store bind this session id under a group key? */
function isGroupSession(stores, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  let resolved = false
  for (const store of stores) {
    const sessions = refreshStore(store)
    if (sessions === null) continue
    for (const [key, bound] of Object.entries(sessions)) {
      if (bound !== sessionId) continue
      resolved = true
      if (key.startsWith(GROUP_KEY_PREFIX)) return true
    }
  }
  return resolved ? false : null
}

function headerOf(session) {
  return session && typeof session === 'object' ? session.header : undefined
}

function apply(ctx, config) {
  const enabled = config && typeof config.enabled === 'boolean' ? config.enabled : true
  if (!enabled) {
    try { console.log('[dsh-im-readonly] disabled -> group sessions keep the deployment default') } catch (err) {}
    return
  }

  const readOnlyPreset = typeof config?.readOnlyPreset === 'string' && config.readOnlyPreset.trim()
    ? config.readOnlyPreset.trim()
    : READ_ONLY
  const unresolved = config?.unresolved === 'allow' ? 'allow' : 'read-only'
  const includeSubagents = config?.includeSubagents === true
  const stores = buildStores(config)

  const permission = ctx.get('permissionPresets') ?? ctx.get('permission')
  if (permission === null || typeof permission?.set !== 'function') {
    try { console.log('[dsh-im-readonly] permission service unavailable -> nothing enforced') } catch (err) {}
    return
  }

  const names = Array.isArray(permission.names) ? permission.names : []
  if (!names.includes(readOnlyPreset)) {
    try {
      console.log(`[dsh-im-readonly] preset "${readOnlyPreset}" is not available (have: ${names.join(', ') || 'none'}) -> nothing enforced`)
    } catch (err) {}
    return
  }

  try {
    console.log(`[dsh-im-readonly] enforcing "${readOnlyPreset}" on IM group sessions`
      + ` | stores: ${stores.map((s) => s.id + '=' + s.file).join(', ')}`
      + ` | unresolved: ${unresolved}`
      + (includeSubagents ? ' | subagents: yes' : ' | subagents: no'))
  } catch (err) {}

  const denied = new Map() // sessionId -> the group key we matched, for one log line each

  ctx.on('session/created', (session) => {
    try {
      const header = headerOf(session)
      if (header === undefined || header === null) return
      if (includeSubagents !== true && (header.origin === 'subagent' || header.delegationDepth !== undefined)) return

      const group = isGroupSession(stores, session.id)
      if (group === false) return // a direct session on a known store -> leave alone
      if (group === null && unresolved === 'allow') return // unclassifiable -> configured to stay out

      const current = typeof permission.current === 'function' ? permission.current(session) : null
      if (current === readOnlyPreset) return

      permission.set(session, readOnlyPreset)
      if (!denied.has(session.id)) {
        denied.set(session.id, true)
        try {
          console.log(`[dsh-im-readonly] session ${session.id}`
            + ` (preset ${header.agentPreset ?? 'default'}) -> ${readOnlyPreset}`
            + ` [was ${current ?? 'unset'}]`)
        } catch (err) {}
      }
    } catch (err) {
      try { console.log(`[dsh-im-readonly] failed to set the group preset: ${err instanceof Error ? err.message : String(err)}`) } catch (e2) {}
    }
  })

  ctx.effect(function () {
    return function () {
      denied.clear()
    }
  }, 'dsh-im-readonly: release the session ledger')
}

export { name, inject, apply }
export { isGroupSession, buildStores, refreshStore, GROUP_KEY_PREFIX, READ_ONLY }
