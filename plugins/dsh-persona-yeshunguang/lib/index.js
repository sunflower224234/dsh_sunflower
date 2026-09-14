// dsh-persona-yeshunguang - System Prompt persona plugin (multi-persona, channel-aware).
//
// Originally: one fixed persona (叶瞬光) injected into EVERY session. That is wrong
// once a second surface competes for the same identity - the QQ bot must be able to
// carry a persona of its own without the deployment default leaking into it.
//
// How the two surfaces are told apart: each QQ bot is assigned its own agent preset
// (`qq-yinlang`), and DSH records that id durably in the session header
// (`session.header.agentPreset`). The assembly context carries `agent`, so a session
// whose `agentPreset` is listed as a preset-scoped persona below does NOT receive the
// deployment-wide persona. Everything else (Web GUI, subagents, other presets) keeps
// receiving the default persona exactly as before.
//
// Why post-assembly injection (instead of `systemPrompt.section()`): a session's agent
// preset can set a `complete: true` persona, and DSH then drops every other globally
// registered section (see zh_pro's own comment). Registering a *separate* section gets
// thrown away in that case. Wrapping `systemPrompt.assemble` and patching the returned
// `assembly.sections` runs AFTER the assembly, so the persona cannot be dropped - the
// same technique deepseek-harness-zh_pro uses for its notice.
//
// We write the canonical persona section name, so this is the REAL persona slot
// (`deployment:persona-prefix`, order 0). The pre-0.1.5 `deployment:persona` /
// `persona` names are stripped from the assembly if anything still emits them, so the
// model never receives two competing personas.
//
// Behaviors:
//   - Switch: `config.enabled` (bool, cordis.patch.yml) OR env DSH_PERSONA_ENABLED (1/0). Default on.
//   - Persona files: env DSH_PERSONA_FILE (default persona) and DSH_PERSONA_QQ_FILE
//     (QQ persona). Each file may wrap the persona in a ```text block (first block wins)
//     or be the raw persona text.
//   - A missing/unreadable/empty file just disables THAT persona; the other still works.
//   - Does NOT change model params, tool permissions, or chat-history logic.

import fs from 'node:fs'

const name = 'dsh-persona-yeshunguang'
const inject = ['systemPrompt']

const FILE_DEFAULT = 'F:/AI/data/叶瞬光人设提示词-精简版.md'
const FILE_QQ_DEFAULT = 'F:/AI/data/银狼人设提示词-QQ精简版.md'
const PERSONA_SECTION = 'deployment:persona-prefix'
// Names retired by DSH 0.1.5 (single persona section was split into prefix/suffix).
// Stripped from any assembly so a stale injector cannot add a second persona.
const LEGACY_PERSONA_SECTIONS = ['deployment:persona', 'persona']
// Agent presets that own their own persona (see $DSH_HOME/.agent-presets/<id>).
const QQ_PRESET_ID_DEFAULT = 'qq-yinlang'

const SINCE_DEFAULT = '>=0.1.5'

function isEnabled(config) {
  if (config && typeof config.enabled === 'boolean') return config.enabled
  const e = process.env.DSH_PERSONA_ENABLED
  if (e === undefined) return true
  return !(e === '0' || String(e).toLowerCase() === 'false')
}

/** Extract the first ```...``` code block, or the whole text when there is none. */
function extractPersona(content) {
  const lines = String(content).split(/\r?\n/)
  let inside = false
  let opened = false
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!inside) {
      if (t.startsWith('```')) { inside = true; opened = true; continue }
    } else {
      if (t.startsWith('```')) return out.join('\n').trim()
      out.push(line)
    }
  }
  return opened ? out.join('\n').trim() : String(content).trim()
}

function readPersona(file) {
  try {
    const text = extractPersona(fs.readFileSync(file, 'utf8'))
    return text && text.length >= 2 ? text : null
  } catch (err) {
    return null
  }
}

/**
 * Re-read one persona file only when its mtime moved, and watch for deletion.
 *
 * Watching through mtime instead of `fs.watch` keeps this deterministic and free of
 * platform-specific event quirks: one `statSync` per assemble is cheap next to a model
 * request, and a deleted file correctly degrades the persona to absent.
 * @returns true when the cached text changed.
 */
function refreshPersona(persona) {
  let mtimeMs = null
  try {
    mtimeMs = fs.statSync(persona.file).mtimeMs
  } catch (err) {
    mtimeMs = null
  }
  if (persona.mtimeMs === mtimeMs && persona.text !== undefined) return false
  persona.mtimeMs = mtimeMs
  persona.text = mtimeMs === null ? null : readPersona(persona.file)
  try {
    console.log(`[dsh-persona-yeshunguang] ${persona.id}: persona file `
      + (persona.text === null ? 'unavailable -> not injected' : `reloaded (${persona.text.length} chars)`))
  } catch (err) {}
  return true
}

/** Parse a `since` constraint: '0.1.5' | '>=0.1.5' | '>0.1.5' | '<=0.1.5' | '<0.1.5'. */
function parseConstraint(spec) {
  if (typeof spec !== 'string') return null
  const m = /^\s*(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+)*)\s*$/.exec(spec)
  if (!m) return null
  return { op: m[1] || '=', parts: m[2].split('.').map(Number) }
}

function compareVersions(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Read the running harness version from the installed dsh package (best effort). */
function harnessVersion() {
  try {
    const url = import.meta.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(fs.readFileSync(new URL(url), 'utf8')).version || null
  } catch (err) {
    return null
  }
}

/**
 * A missing/malformed constraint matches, so a bad spec can never silently disable
 * the persona on an unknown harness build. Only a parseable mismatch skips.
 */
function sinceMatches(spec, version) {
  if (spec === null || spec === undefined) return true
  const constraint = parseConstraint(spec)
  if (constraint === null) return true
  const current = parseConstraint(version)
  if (current === null) return true
  const cmp = compareVersions(current.parts, constraint.parts)
  switch (constraint.op) {
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    default: return cmp === 0
  }
}

/** Normalize one persona entry from `config.personas`. */
function normalizePersona(entry, envFile) {
  if (entry === null || typeof entry !== 'object') return null
  const file = typeof entry.file === 'string' && entry.file.trim()
    ? entry.file.trim()
    : envFile
  if (!file) return null
  const presetIds = Array.isArray(entry.presetIds)
    ? entry.presetIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : []
  const suppressSections = Array.isArray(entry.suppressSections)
    ? entry.suppressSections.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : []
  const since = typeof entry.since === 'string' && entry.since.trim()
    ? entry.since.trim()
    : SINCE_DEFAULT
  // `reload` defaults to true: re-read the file when its mtime changes, so persona
  // tuning never requires restarting the host. Set false to freeze at startup.
  const reload = entry.reload !== false
  return {
    id: String(entry.id || file),
    file,
    presetIds,
    suppressSections,
    since,
    reload,
    text: null,
    mtimeMs: null,
    lastHiddenCount: -1,
    lastHiddenMark: null,
  }
}

/**
 * Build the persona registry once at startup.
 * `presetIds: []`  -> deployment-wide default (every session that is not claimed by
 *                     another preset-scoped persona).
 * `presetIds: [x]` -> only sessions whose header agentPreset is one of these.
 */
function buildPersonas(config) {
  const envDefault = process.env.DSH_PERSONA_FILE || FILE_DEFAULT
  const envQq = process.env.DSH_PERSONA_QQ_FILE || FILE_QQ_DEFAULT
  const entries = config && Array.isArray(config.personas) ? config.personas : null
  if (entries === null) {
    // Legacy single-persona configuration: keep the pre-existing behaviour exactly.
    return [{
      id: 'default',
      file: envDefault,
      presetIds: [],
      suppressSections: [],
      since: null, // no version gate in legacy mode
      reload: true,
      text: null,
      mtimeMs: null,
      lastHiddenCount: -1,
      lastHiddenMark: null,
    }]
  }
  const personas = []
  const seen = new Set()
  for (const entry of entries) {
    const envFile = entry && entry.role === 'qq' ? envQq : envDefault
    const persona = normalizePersona(entry, envFile)
    if (persona === null || seen.has(persona.id)) continue
    seen.add(persona.id)
    personas.push(persona)
  }
  return personas
}

/**
 * The persona this agent should get, or null when it must keep the deployment default.
 *
 * `since` gates only the preset-scoped override, so a version mismatch degrades to the
 * deployment persona instead of to NO persona - a session must never be left without
 * one just because a harness version moved.
 */
function personaFor(personas, agent, harness) {
  const presetId = agent?.session?.header?.agentPreset
  if (typeof presetId === 'string') {
    for (const persona of personas) {
      if (persona.presetIds.length === 0) continue
      if (persona.presetIds.includes(presetId) && sinceMatches(persona.since, harness)) {
        return persona
      }
    }
  }
  for (const persona of personas) {
    if (persona.presetIds.length !== 0) continue
    return persona
  }
  return null
}

/** Insert/replace the persona section in an already-assembled prompt. */
function syncPersona(assembly, personaText) {
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return
  const sec = { name: PERSONA_SECTION, order: 0, text: personaText }
  const idx = assembly.sections.findIndex((s) => s && s.name === PERSONA_SECTION)
  if (idx >= 0) {
    assembly.sections[idx] = sec
  } else {
    // Insert directly after the last identity instruction (negative-order sections).
    let pos = 0
    for (let i = 0; i < assembly.sections.length; i++) {
      const o = assembly.sections[i] && assembly.sections[i].order
      if (typeof o === 'number' && o < 0) pos = i + 1
    }
    assembly.sections.splice(pos, 0, sec)
  }
  // Drop persona sections written under names this deployment no longer uses, so a
  // stale injector can never leave the model with two competing personas.
  for (let i = assembly.sections.length - 1; i >= 0; i -= 1) {
    const secName = assembly.sections[i] && assembly.sections[i].name
    if (typeof secName === 'string' && LEGACY_PERSONA_SECTIONS.includes(secName)) {
      assembly.sections.splice(i, 1)
    }
  }
}

/**
 * Remove sections this persona must not see.
 *
 * This is what keeps a chat persona IN character: the deployment's own prompt tells the
 * model it is "an AI agent powered by DeepSeek Harness", that it lives in the Web GUI at
 * a loopback URL, and where the harness checkout sits. Those three statements are true of
 * the runtime and false of the character, so a persona that stays in role has to drop
 * them - no wording in the persona text can outrank a first-party identity line.
 */
function stripSections(assembly, names) {
  if (names.length === 0) return 0
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return 0
  let removed = 0
  for (let i = assembly.sections.length - 1; i >= 0; i -= 1) {
    const secName = assembly.sections[i] && assembly.sections[i].name
    if (typeof secName === 'string' && names.includes(secName)) {
      assembly.sections.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

/** Trim the deployment-wide persona for this session (used for preset-owned personas). */
function stripPersona(assembly) {
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return
  for (let i = assembly.sections.length - 1; i >= 0; i -= 1) {
    const secName = assembly.sections[i] && assembly.sections[i].name
    if (secName === PERSONA_SECTION
      || (typeof secName === 'string' && LEGACY_PERSONA_SECTIONS.includes(secName))) {
      assembly.sections.splice(i, 1)
    }
  }
}

function apply(ctx, config) {
  if (!isEnabled(config)) {
    try { console.log('[dsh-persona-yeshunguang] disabled -> persona not injected') } catch (err) {}
    return
  }

  // First read at startup; each file is cached for the whole process unless its
  // mtime changes (see refreshPersonas), so tuning a persona needs no restart.
  const harness = harnessVersion()
  const personas = buildPersonas(config)
  for (const persona of personas) refreshPersona(persona)
  let loaded = personas.filter((persona) => persona.text !== null)

  try {
    console.log('[dsh-persona-yeshunguang] personas: '
      + (loaded.length === 0
        ? 'none loaded -> original system prompt preserved'
        : loaded.map((persona) => persona.id
          + (persona.presetIds.length ? `(preset: ${persona.presetIds.join('/')})` : '(deployment)')
          + (persona.suppressSections.length ? ` (hides: ${persona.suppressSections.join('/')})` : '')
          + (persona.reload ? ' (hot)' : ' (frozen)')
          + (persona.since ? ` since ${persona.since}` : '')).join(', '))
      + ` | harness ${harness || 'unknown'}`)
  } catch (err) {}

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === null || typeof systemPrompt?.assemble !== 'function') {
    try { console.log('[dsh-persona-yeshunguang] systemPrompt service unavailable -> fallback to original system prompt') } catch (err) {}
    return
  }

  const originalAssemble = systemPrompt.assemble
  const patchedAssemble = async function (...args) {
    const assembly = await Reflect.apply(originalAssemble, this, args)
    const context = args[0]
    const agent = context && typeof context === 'object' ? context.agent : null
    // Cheap mtime check; only a changed file triggers a read.
    for (const persona of personas) {
      if (persona.reload) refreshPersona(persona)
    }
    loaded = personas.filter((persona) => persona.text !== null)
    const persona = loaded.length > 0 ? personaFor(loaded, agent, harness) : null
    if (persona !== null && persona.text !== null) {
      syncPersona(assembly, persona.text)
      // Remove the runtime's own self-description so the character cannot recite it.
      const hidden = stripSections(assembly, persona.suppressSections)
      if (hidden > 0 && persona.reload) {
        const mark = persona.id + ':' + String(persona.mtimeMs)
        if (hidden !== persona.lastHiddenCount || mark !== persona.lastHiddenMark) {
          persona.lastHiddenCount = hidden
          persona.lastHiddenMark = mark
          try {
            console.log(`[dsh-persona-yeshunguang] ${persona.id}: hid ${hidden} section(s) [${persona.suppressSections.join(', ')}]`)
          } catch (err) {}
        }
      }
    } else {
      // No persona for this agent. Nothing loaded at all means "stay out of the way"
      // (the original behaviour); a loaded registry with no match means the agent is a
      // preset-scoped one, so the deployment persona is removed rather than left in.
      if (loaded.length > 0) stripPersona(assembly)
    }
    return assembly
  }
  // Use DISTINCT marker names (not zh_pro's `__dshZhAssembleWrapped`).
  //
  // deepseek-harness-zh_pro also wraps `systemPrompt.assemble`, and it UNWRAPS by
  // walking a marker chain while RESETTING the instance property to
  // `Object.getPrototypeOf(service).assemble` to shed historical wrappers. Sharing its
  // marker name makes this layer look like one of its own, so its chain walk skips
  // straight past it - the persona then silently stops being injected, which is exactly
  // the 2026-09-11 failure (QQ bot answered as "DeepSeek Harness 上跑的 AI agent, 住在
  // 这个 Web GUI 里 (127.0.0.1:3080)").
  //
  // With our own marker names, zh_pro's walk stops at this layer and re-wraps on top of
  // it, so both plugins compose. See the matching stop condition in that plugin's
  // `ensureAssemblePatch`.
  patchedAssemble.__dshPersonaAssembleWrapped = true
  patchedAssemble.__dshPersonaAssembleInner = originalAssemble
  try {
    systemPrompt.assemble = patchedAssemble
    ctx.effect(function () {
      return function () {
        try {
          if (systemPrompt.assemble === patchedAssemble) systemPrompt.assemble = originalAssemble
        } catch (err) {}
      }
    }, 'dsh-persona-yeshunguang.assemble()')
  } catch (err) {
    try { console.log('[dsh-persona-yeshunguang] assemble wrap failed -> fallback to original system prompt') } catch (e2) {}
    return
  }
  try {
    console.log('[dsh-persona-yeshunguang] assemble wrapped (marker-joined with dsh-zh)')
  } catch (err) {}
}

export { name, inject, apply }
export { buildPersonas, personaFor, sinceMatches, extractPersona, QQ_PRESET_ID_DEFAULT }
