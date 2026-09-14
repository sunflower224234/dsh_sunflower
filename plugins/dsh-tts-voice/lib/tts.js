// dsh-tts-voice — client reader (injected via webServer.tapIndex).
// Plain classic script. Polls /dsh-tts/state, fetches ready WAV clips, and plays them
// in order. Only clips generated AFTER this page loaded are spoken (no history replay).
// Floating control (fixed bottom-right, above the whale): mute toggle + hover popover with
// a volume slider and a voice selector.
(function () {
  if (window.__DSH_TTS_LOADED__) return
  window.__DSH_TTS_LOADED__ = true

  var STATE = '/dsh-tts/state'
  var AUDIO = '/dsh-tts/audio'
  var CONSUMED = '/dsh-tts/consumed'
  var MUTE = '/dsh-tts/mute'
  var VOICE = '/dsh-tts/voice'

  var muted = localStorage.getItem('dshttsoff') === '1'
  var stored = localStorage.getItem('dshttssvol')
  var vol = stored === null ? 1 : Math.min(1, Math.max(0, Number(stored) || 1)) // 0..1
  var initialized = false
  var cursor = 0 // last id already played (or the id at page load)
  var fetched = {} // id -> true, already queued
  var queue = [] // ids waiting to play, in order
  var playing = false
  var starting = false
  var audio = null

  function setVol(v) {
    vol = Math.min(1, Math.max(0, Number(v) || 0))
    try { localStorage.setItem('dshttssvol', String(vol)) } catch (e) {}
    if (audio) { try { audio.volume = vol } catch (e) {} }
    updateLabel()
    updateVolUI()
  }

  function setMuted(m) {
    muted = m
    try { localStorage.setItem('dshttsoff', m ? '1' : '0') } catch (e) {}
    if (m) {
      queue = []
      fetched = {}
      if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load() } catch (e) {} }
      playing = false
    }
    try { fetch(MUTE + '?on=' + (m ? '1' : '0'), { cache: 'no-store' }) } catch (e) {}
    updateLabel()
    showVol(false)
  }

  function setVoice(id) {
    try { fetch(VOICE + '?set=' + encodeURIComponent(id), { cache: 'no-store' }) } catch (e) {}
    if (voiceSelect) voiceSelect.value = id
  }

  function loadVoices() {
    fetch(VOICE, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (!voiceSelect || !data || !data.voices) return
        voiceSelect.innerHTML = ''
        data.voices.forEach(function (v) {
          var op = document.createElement('option')
          op.value = v.id
          op.textContent = v.label
          voiceSelect.appendChild(op)
        })
        if (data.active) voiceSelect.value = data.active
      })
      .catch(function () {})
  }

  function playNext() {
    if (playing || muted || queue.length === 0) return
    var id = queue.shift()
    playing = true
    if (!audio) { audio = new Audio(); try { audio.volume = vol } catch (e) {} }
    audio.onended = function () { onDone(id) }
    audio.onerror = function () { onDone(id) }
    audio.src = AUDIO + '?id=' + id
    if (!playing) return
    audio.play().catch(function () { onDone(id) })
  }

  function onDone(id) {
    playing = false
    if (id > cursor) cursor = id
    try { fetch(CONSUMED + '?id=' + id, { cache: 'no-store' }) } catch (e) {}
    setTimeout(playNext, 30)
  }

  function poll() {
    fetch(STATE, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (!data || !data.items) return
        var s = !!data.starting
        if (s !== starting) { starting = s; updateLabel() }
        var items = data.items.slice().sort(function (a, b) { return a.id - b.id })
        if (!initialized) {
          initialized = true
          // Only speak clips produced after this page loaded.
          if (items.length) cursor = items[items.length - 1].id
          return
        }
        for (var i = 0; i < items.length; i++) {
          var it = items[i]
          if (it.id <= cursor || fetched[it.id]) continue
          fetched[it.id] = true
          queue.push(it.id)
        }
        playNext()
      })
      .catch(function () {})
  }

  function updateLabel() {
    if (lbl) {
      lbl.textContent = muted
        ? '🔇 语音 关'
        : (starting ? '🔊 模型加载中…' : '🔊 语音 开 · ' + Math.round(vol * 100) + '%')
    }
  }

  function updateVolUI() {
    if (!volInput || !volPct) return
    volInput.value = String(Math.round(vol * 100))
    volPct.textContent = Math.round(vol * 100) + '%'
  }

  var btn = null
  var lbl = null
  var volInput = null
  var volPct = null
  var volWrap = null
  var voiceSelect = null
  var hideTimer = null

  function showVol(show) {
    if (!volWrap) return
    if (show && !muted) {
      volWrap.style.opacity = '1'
      volWrap.style.pointerEvents = 'auto'
    } else {
      volWrap.style.opacity = '0'
      volWrap.style.pointerEvents = 'none'
    }
  }

  function build() {
    var root = document.createElement('div')
    root.id = 'dshtts-root'
    root.style.position = 'fixed'
    root.style.left = '16px'
    root.style.bottom = '92px'
    root.style.zIndex = '2147483000'
    root.style.display = 'none'
    root.style.flexDirection = 'column'
    root.style.alignItems = 'flex-start'
    root.style.gap = '6px'
    root.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif'
    root.style.userSelect = 'none'

    // popover (volume + voice) revealed on hovering the pill
    volWrap = document.createElement('div')
    volWrap.id = 'dshtts-volwrap'
    volWrap.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;' +
      'background:rgba(22,22,26,0.92);border:1px solid rgba(255,255,255,0.14);' +
      'border-radius:12px;padding:8px 10px;box-shadow:0 2px 8px rgba(0,0,0,0.35);' +
      'opacity:0;transition:opacity .15s;pointer-events:none;cursor:default;min-width:158px'
    // volume row
    var volRow = document.createElement('div')
    volRow.style.cssText = 'display:flex;align-items:center;gap:6px'
    var vIcon = document.createElement('span')
    vIcon.textContent = '🔊'
    vIcon.style.fontSize = '14px'
    volInput = document.createElement('input')
    volInput.type = 'range'
    volInput.min = '0'
    volInput.max = '100'
    volInput.step = '1'
    volInput.style.width = '90px'
    volInput.style.accentColor = '#4c9bff'
    volPct = document.createElement('span')
    volPct.style.cssText = 'font-size:12px;color:#e8e8ea;min-width:34px;text-align:right'
    volRow.appendChild(vIcon)
    volRow.appendChild(volInput)
    volRow.appendChild(volPct)
    volWrap.appendChild(volRow)
    volInput.addEventListener('input', function () { setVol(Number(volInput.value) / 100) })
    // voice row
    var voiceRow = document.createElement('div')
    voiceRow.style.cssText = 'display:flex;align-items:center;gap:6px'
    var micIcon = document.createElement('span')
    micIcon.textContent = '🎤'
    micIcon.style.fontSize = '14px'
    voiceSelect = document.createElement('select')
    voiceSelect.style.cssText = 'flex:1;background:rgba(255,255,255,0.08);color:#e8e8ea;' +
      'border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:3px 6px;' +
      'font-size:12px;outline:none;appearance:auto'
    voiceRow.appendChild(micIcon)
    voiceRow.appendChild(voiceSelect)
    volWrap.appendChild(voiceRow)
    voiceSelect.addEventListener('change', function () { setVoice(voiceSelect.value) })
    root.appendChild(volWrap)

    // mute pill
    btn = document.createElement('div')
    btn.id = 'dshtts-btn'
    btn.setAttribute('role', 'button')
    btn.style.cssText = 'padding:6px 12px;font-size:13px;line-height:1.3;cursor:pointer;' +
      'border-radius:999px;background:rgba(22,22,26,0.85);color:#e8e8ea;' +
      'border:1px solid rgba(255,255,255,0.14);box-shadow:0 2px 8px rgba(0,0,0,0.35);' +
      'backdrop-filter:blur(4px)'
    lbl = document.createElement('span')
    btn.appendChild(lbl)
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation()
      setMuted(!muted)
      updateLabel()
      try { if (audio && !muted) audio.play().catch(function () {}) } catch (e) {}
      playNext()
    })
    btn.addEventListener('mouseenter', function () {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      showVol(true)
    })
    btn.addEventListener('mouseleave', function () {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(function () { showVol(false) }, 350)
    })
    root.appendChild(btn)

    document.body.appendChild(root)
    updateLabel()
    updateVolUI()
    loadVoices()

    setTimeout(function () { root.style.display = 'flex' }, 400)
  }

  // Unlock on first real interaction (autoplay policy).
  function unlock() { playNext() }
  document.addEventListener('pointerdown', unlock, { once: true })
  document.addEventListener('keydown', unlock, { once: true })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build)
  } else {
    build()
  }

  setMuted(muted) // sync server
  setInterval(poll, 350)
})()
