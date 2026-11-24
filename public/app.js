const $ = (id) => document.getElementById(id)
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const state = { jobId: null, connection: 'disconnected', audioUrl: null, playing: false }
let previewAudio = null

function setLoading(btn, on) {
  if (!btn) return
  btn.classList.toggle('loading', on)
  btn.disabled = on || (btn === $('btn-send') && (state.connection !== 'open' || !state.jobId))
}

function toast(message, type = 'info') {
  const wrap = $('toasts')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  wrap.append(el)
  const hold = type === 'error' ? 5200 : 3600
  setTimeout(() => el.classList.add('out'), hold)
  setTimeout(() => el.remove(), hold + 280)
}

function addLog(message, asToast) {
  const li = document.createElement('li')
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  li.textContent = `${time} — ${message}`
  $('log').prepend(li)
  if (asToast === 'error' || asToast === 'ok' || asToast === 'info') toast(message, asToast)
}

function setPill(connection) {
  const pill = $('status-pill')
  pill.className = `pill ${connection}`
  const labels = {
    disconnected: 'desconectado',
    connecting: 'conectando',
    qr: 'aguardando QR',
    open: 'conectado'
  }
  pill.textContent = labels[connection] || connection
}

function updateSteps() {
  const prepared = Boolean(state.jobId)
  const connected = state.connection === 'open'
  const map = {
    1: connected ? 'is-done' : 'is-active',
    2: prepared ? 'is-done' : (connected ? 'is-active' : ''),
    3: prepared && connected ? 'is-active' : ''
  }
  document.querySelectorAll('.step').forEach((el) => {
    const n = el.dataset.step
    el.classList.remove('is-active', 'is-done')
    if (map[n]) el.classList.add(...map[n].split(' ').filter(Boolean))
  })
}

function applyStatus(s) {
  if (!s) return
  state.connection = s.connection
  setPill(s.connection)
  $('btn-send').disabled = s.connection !== 'open' || !state.jobId || $('btn-send').classList.contains('loading')
  if (s.selfJid) {
    $('self-line').textContent = `Conectado como ${s.selfJid.replace(/@s\.whatsapp\.net$/, '')}`
  } else if (s.connection === 'qr') {
    $('self-line').textContent = 'Leia o QR com o celular do número reserva.'
  } else if (s.pairingCode) {
    $('self-line').textContent = 'Digite o código no celular.'
  } else {
    $('self-line').textContent = s.hasAuth
      ? 'Há uma sessão salva neste computador. Clique em Mostrar QR para reutilizar.'
      : 'Ainda não há sessão neste computador.'
  }
  if (s.qrDataUrl) {
    $('qr-img').src = s.qrDataUrl
    $('qr-wrap').hidden = false
  } else if (s.connection === 'open' || s.connection === 'disconnected') {
    $('qr-wrap').hidden = true
  }
  if (s.pairingCode) {
    $('pair-code').hidden = false
    $('pair-code').textContent = s.pairingCode
  }
  if (s.lastError) addLog(s.lastError, 'error')
  updateSteps()
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : JSON.stringify(body || {})
  })
  const data = await res.json().catch(() => ({ ok: false, error: 'Resposta inválida' }))
  if (!res.ok || data.ok === false) throw new Error(data.error || `Erro ${res.status}`)
  return data
}

function bindDrop(zoneId, inputId, nameId) {
  const zone = $(zoneId)
  const input = $(inputId)
  const onFiles = (files) => {
    if (!files || !files.length) return
    const dt = new DataTransfer()
    dt.items.add(files[0])
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ;['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault()
      zone.classList.add('is-over')
    })
  })
  ;['dragleave', 'drop'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault()
      zone.classList.remove('is-over')
    })
  })
  zone.addEventListener('drop', (e) => onFiles(e.dataTransfer?.files))
  input.addEventListener('change', () => {
    const file = input.files[0]
    $(nameId).textContent = file ? file.name : ''
    zone.classList.toggle('has-file', Boolean(file))
  })
}

function stopPreviewAudio() {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.currentTime = 0
  }
  state.playing = false
  $('btn-play').classList.remove('is-playing')
}

function bindPlay() {
  const btn = $('btn-play')
  btn.addEventListener('click', () => {
    if (!state.audioUrl) return
    if (!previewAudio || previewAudio.src !== new URL(state.audioUrl, location.href).href) {
      previewAudio = new Audio(state.audioUrl)
      previewAudio.addEventListener('ended', stopPreviewAudio)
    }
    if (state.playing) {
      previewAudio.pause()
      state.playing = false
      btn.classList.remove('is-playing')
      return
    }
    previewAudio.play().then(() => {
      state.playing = true
      btn.classList.add('is-playing')
    }).catch((err) => addLog(err.message || 'Não deu para ouvir o áudio.', 'error'))
  })
}

function burstSuccess() {
  const canvas = $('burst')
  if (reduceMotion || !canvas) {
    toast('Figurinha enviada.', 'ok')
    return
  }
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(window.innerWidth * dpr)
  canvas.height = Math.floor(window.innerHeight * dpr)
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  const colors = ['#25d366', '#00e5a0', '#ffffff', '#f5c542', '#9bffce']
  const parts = Array.from({ length: 90 }, () => {
    const angle = Math.random() * Math.PI * 2
    const speed = 4 + Math.random() * 9
    return {
      x: canvas.width / 2,
      y: canvas.height * 0.38,
      vx: Math.cos(angle) * speed * dpr,
      vy: Math.sin(angle) * speed * dpr - 3 * dpr,
      g: 0.18 * dpr,
      size: (4 + Math.random() * 6) * dpr,
      color: colors[(Math.random() * colors.length) | 0],
      life: 1
    }
  })
  const start = performance.now()
  function frame(now) {
    const t = (now - start) / 1000
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    parts.forEach((p) => {
      p.vy += p.g
      p.x += p.vx
      p.y += p.vy
      p.life = Math.max(0, 1 - t / 1.15)
      ctx.globalAlpha = p.life
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    })
    if (t < 1.2) requestAnimationFrame(frame)
    else {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.globalAlpha = 1
    }
  }
  requestAnimationFrame(frame)
}

async function prepareSticker() {
  const media = $('media').files[0]
  if (!media) {
    addLog('Escolha um vídeo ou uma imagem.', 'error')
    return
  }
  const form = new FormData()
  form.append('media', media)
  if ($('audio').files[0]) form.append('audio', $('audio').files[0])
  setLoading($('btn-prepare'), true)
  $('preview').hidden = true
  stopPreviewAudio()
  state.jobId = null
  state.audioUrl = null
  updateSteps()
  try {
    addLog('Convertendo… isso pode levar alguns segundos.', 'info')
    const data = await post('/api/prepare', form)
    state.jobId = data.id
    state.audioUrl = data.audioUrl || null
    $('preview-img').src = data.preview
    const parts = [
      data.isAnimated ? 'animada' : 'estática',
      `${(data.stickerBytes / 1024).toFixed(1)} KB`,
      data.hasAudio ? `áudio ${Number(data.audioSeconds).toFixed(1)} s` : 'sem áudio'
    ]
    $('preview-meta').innerHTML = `<p><strong>${parts.join(' · ')}</strong></p>` +
      (data.warnings || []).map((w) => `<p class="hint">${w}</p>`).join('')
    $('btn-play').hidden = !data.hasAudio
    $('preview').hidden = false
    $('btn-send').disabled = state.connection !== 'open'
    updateSteps()
    toast('Figurinha pronta.', 'ok')
  } catch (err) {
    addLog(err.message, 'error')
  } finally {
    setLoading($('btn-prepare'), false)
    $('btn-prepare').disabled = false
  }
}

$('btn-connect').addEventListener('click', async () => {
  try {
    setLoading($('btn-connect'), true)
    addLog('Pedindo QR…', 'info')
    const s = await post('/api/connect')
    applyStatus(s)
  } catch (err) { addLog(err.message, 'error') }
  finally { setLoading($('btn-connect'), false); $('btn-connect').disabled = false }
})

$('btn-pair').addEventListener('click', async () => {
  try {
    const phone = $('phone').value.trim()
    setLoading($('btn-pair'), true)
    addLog('Pedindo código de emparelhamento…', 'info')
    const s = await post('/api/pair', { phone })
    applyStatus(s)
    if (s.pretty || s.code) {
      $('pair-code').hidden = false
      $('pair-code').textContent = s.pretty || s.code
    }
  } catch (err) { addLog(err.message, 'error') }
  finally { setLoading($('btn-pair'), false); $('btn-pair').disabled = false }
})

$('btn-disconnect').addEventListener('click', async () => {
  if (!confirm('Desconectar e apagar a sessão salva neste computador?')) return
  try {
    const s = await post('/api/disconnect')
    applyStatus(s)
    $('pair-code').hidden = true
    $('qr-wrap').hidden = true
    toast('Desconectado.', 'ok')
  } catch (err) { addLog(err.message, 'error') }
})

$('btn-prepare').addEventListener('click', prepareSticker)

$('btn-send').addEventListener('click', async () => {
  if (!state.jobId) { addLog('Prepare a figurinha primeiro.', 'error'); return }
  setLoading($('btn-send'), true)
  try {
    const data = await post('/api/send', {
      id: state.jobId,
      to: $('to').value.trim(),
      alsoSilent: $('also-silent').checked
    })
    addLog(`Enviado para ${data.jid}`)
    for (const row of data.results || []) {
      const proto = row.proto || {}
      addLog(`${row.kind === 'sound' ? 'Com som' : 'Muda'}: figurinha=${proto.hasStickerMessage ? 'sim' : 'não'}, áudio=${proto.hasAudioMessage ? 'sim' : 'não'}`)
    }
    toast('Figurinha enviada.', 'ok')
    burstSuccess()
  } catch (err) {
    addLog(err.message, 'error')
  } finally {
    setLoading($('btn-send'), false)
    $('btn-send').disabled = state.connection !== 'open' || !state.jobId
  }
})

document.querySelectorAll('.step').forEach((el) => {
  el.addEventListener('click', () => {
    const map = { 1: 'connect-card', 2: 'prepare-card', 3: 'send-card' }
    const target = $(map[el.dataset.step])
    target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  })
})

;['dragover', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
})

bindDrop('drop-media', 'media', 'media-name')
bindDrop('drop-audio', 'audio', 'audio-name')
bindPlay()

window.burstSuccess = burstSuccess
window.__toast = toast

async function boot() {
  try {
    const s = await fetch('/api/status').then((r) => r.json())
    applyStatus(s)
  } catch {}
  const ev = new EventSource('/api/events')
  ev.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)))
  ev.addEventListener('log', (e) => {
    const row = JSON.parse(e.data)
    if (row.message) addLog(row.message)
  })
}
boot()
