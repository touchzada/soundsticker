import { rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} from 'plogme'
import { authDir } from './paths.mjs'

const silentLogger = {
  level: 'warn',
  child() { return this },
  trace() {},
  debug() {},
  info() {},
  warn(...args) { console.warn('[wa]', ...args) },
  error(...args) { console.error('[wa]', ...args) },
  fatal(...args) { console.error('[wa]', ...args) }
}

function emptyState() {
  return {
    connection: 'disconnected',
    qrDataUrl: null,
    pairingCode: null,
    selfJid: null,
    lastError: null
  }
}

function digitsOnly(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length < 10) throw new Error('O número precisa incluir o DDI, por exemplo 5511999999999')
  return d
}

export function toJid(input, selfJid) {
  if (!input) {
    if (!selfJid) throw new Error('Sem destino e a conta ainda não está conectada')
    return selfJid
  }
  const s = String(input).trim()
  if (s.includes('@')) return s
  const digits = s.replace(/\D/g, '')
  if (digits.length < 8) throw new Error(`Número de destino inválido: ${input}`)
  return `${digits}@s.whatsapp.net`
}

function summarizeProto(waMessage) {
  const content = waMessage?.message || waMessage || {}
  const sticker = content.stickerMessage || null
  const audio = sticker?.audioMessage || null
  const brief = (buf) => {
    if (!buf) return null
    if (typeof buf === 'string') return { type: 'string', length: buf.length }
    const len = buf.length ?? buf.byteLength
    return { type: 'bytes', length: len }
  }
  return {
    hasStickerMessage: Boolean(sticker),
    hasAudioMessage: Boolean(audio),
    stickerMessage: sticker && {
      mimetype: sticker.mimetype ?? null,
      width: sticker.width ?? null,
      height: sticker.height ?? null,
      isAnimated: sticker.isAnimated ?? null,
      fileLength: sticker.fileLength?.toString?.() ?? sticker.fileLength ?? null,
      hasUrl: Boolean(sticker.url),
      hasDirectPath: Boolean(sticker.directPath),
      fileSha256: brief(sticker.fileSha256),
      hasMediaKey: Boolean(sticker.mediaKey)
    },
    audioMessage: audio && {
      mimetype: audio.mimetype ?? null,
      ptt: audio.ptt ?? null,
      seconds: audio.seconds ?? null,
      fileLength: audio.fileLength?.toString?.() ?? audio.fileLength ?? null,
      hasUrl: Boolean(audio.url),
      hasDirectPath: Boolean(audio.directPath),
      hasMediaKey: Boolean(audio.mediaKey)
    }
  }
}

export function createWhatsAppManager({ onChange } = {}) {
  let sock = null
  let state = emptyState()
  let saveCreds = async () => {}
  let connecting = false

  const emit = (patch = {}) => {
    state = { ...state, ...patch }
    onChange?.(getState())
  }

  function getState() {
    return { ...state, hasAuth: existsSync(authDir()) }
  }

  async function stopSocket() {
    const current = sock
    sock = null
    if (!current) return
    try { current.end() } catch {}
  }

  async function connect() {
    if (state.connection === 'open' && sock) return getState()
    if (connecting) return getState()
    connecting = true
    await stopSocket()
    emit({ connection: 'connecting', qrDataUrl: null, pairingCode: null, lastError: null })

    await mkdir(authDir(), { recursive: true })
    const auth = await useMultiFileAuthState(authDir())
    saveCreds = auth.saveCreds

    sock = makeWASocket({
      auth: auth.state,
      logger: silentLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    })
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        const { default: qrcode } = await import('qrcode')
        const qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
        emit({ connection: 'qr', qrDataUrl, lastError: null })
      }
      if (connection === 'open') {
        const selfJid = jidNormalizedUser(sock.user?.id)
        emit({ connection: 'open', qrDataUrl: null, pairingCode: null, selfJid, lastError: null })
      }
      if (connection === 'close') {
        const status = lastDisconnect?.error?.output?.statusCode
        const loggedOut = status === DisconnectReason.loggedOut
        sock = null
        connecting = false
        if (loggedOut) {
          emit({
            connection: 'disconnected',
            selfJid: null,
            qrDataUrl: null,
            pairingCode: null,
            lastError: 'Sessão encerrada. Conecte de novo.'
          })
          return
        }
        if (status === DisconnectReason.restartRequired) {
          emit({ lastError: 'O WhatsApp pediu para reconectar. Tentando de novo…' })
          connecting = false
          setTimeout(() => { connect().catch(() => {}) }, 800)
          return
        }
        emit({
          connection: 'disconnected',
          qrDataUrl: null,
          lastError: `Conexão fechada (código ${status ?? 'desconhecido'}).`
        })
      }
    })

    connecting = false
    return getState()
  }

  async function requestPair(phone) {
    const digits = digitsOnly(phone)
    if (!sock) await connect()
    // pequeno atraso para o socket começar a negociar
    await new Promise((r) => setTimeout(r, 400))
    if (!sock?.requestPairingCode) throw new Error('Não foi possível pedir o código agora. Tente de novo.')
    const code = await sock.requestPairingCode(digits)
    const pretty = String(code).replace(/(.{4})/g, '$1-').replace(/-$/, '')
    emit({ pairingCode: pretty || code, qrDataUrl: null, connection: state.connection === 'open' ? 'open' : 'connecting' })
    return { code, pretty: pretty || code }
  }

  async function disconnect() {
    const current = sock
    sock = null
    connecting = false
    if (current) {
      try { await current.logout() } catch {}
      try { current.end() } catch {}
    }
    if (existsSync(authDir())) {
      await rm(authDir(), { recursive: true, force: true })
    }
    state = emptyState()
    emit()
    return getState()
  }

  async function sendSticker({ stickerPath, audioPath, isAnimated, to, alsoSilent }) {
    if (!sock || state.connection !== 'open') {
      throw new Error('Conecte o WhatsApp antes de enviar')
    }
    const jid = toJid(to, state.selfJid)
    const stickerUrl = stickerPath
    const results = []

    if (alsoSilent) {
      const silentMsg = await sock.sendMessage(jid, {
        sticker: { url: stickerUrl },
        isAnimated: Boolean(isAnimated)
      })
      results.push({ kind: 'silent', proto: summarizeProto(silentMsg) })
    }

    const payload = {
      sticker: { url: stickerUrl },
      isAnimated: Boolean(isAnimated)
    }
    if (audioPath) {
      payload.stickerAudio = { url: audioPath }
    }
    const soundMsg = await sock.sendMessage(jid, payload)
    const proto = summarizeProto(soundMsg)
    results.push({ kind: audioPath ? 'sound' : 'silent', proto })
    if (!proto.hasStickerMessage) {
      throw new Error('O WhatsApp aceitou o envio, mas a mensagem não veio como figurinha')
    }
    return { jid, results }
  }

  return { getState, connect, requestPair, disconnect, sendSticker }
}
