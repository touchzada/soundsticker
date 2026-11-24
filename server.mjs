#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import express from 'express'
import multer from 'multer'
import { convertToSticker } from './lib/convert.mjs'
import { getFfmpegPath } from './lib/ffmpeg.mjs'
import { dataDir, publicDir, tmpDir } from './lib/paths.mjs'
import { createWhatsAppManager } from './lib/whatsapp.mjs'

const PORT = Number(process.env.PORT || 3847)
const HOST = process.env.HOST || '127.0.0.1'
const openBrowser = !['0', 'false', 'no'].includes(String(process.env.OPEN_BROWSER || '1').toLowerCase())
  && !process.argv.includes('--no-open')

const jobs = new Map()
const sseClients = new Set()

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch {}
  }
}

const wa = createWhatsAppManager({
  onChange(state) { broadcast('status', state) }
})

function log(message, extra = {}) {
  const row = { t: new Date().toISOString(), message, ...extra }
  console.log(message)
  broadcast('log', row)
  return row
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        const dir = join(tmpDir(), 'uploads')
        await mkdir(dir, { recursive: true })
        cb(null, dir)
      } catch (err) { cb(err) }
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname || '').slice(0, 10) || ''
      cb(null, `${Date.now()}-${randomUUID()}${ext}`)
    }
  }),
  limits: { fileSize: 80 * 1024 * 1024 }
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use(express.static(publicDir()))

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, ...wa.getState(), ffmpeg: ffmpegSafe() })
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: status\ndata: ${JSON.stringify(wa.getState())}\n\n`)
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

app.post('/api/connect', async (_req, res) => {
  try {
    const state = await wa.connect()
    log('Iniciando conexão com o WhatsApp…')
    res.json({ ok: true, ...state })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/pair', async (req, res) => {
  try {
    const phone = req.body?.phone || ''
    await wa.connect()
    const result = await wa.requestPair(phone)
    log(`Código de emparelhamento gerado para +${String(phone).replace(/\D/g, '')}`)
    res.json({ ok: true, ...result, ...wa.getState() })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

app.post('/api/disconnect', async (_req, res) => {
  try {
    const state = await wa.disconnect()
    log('Desconectado. A sessão local foi apagada.')
    res.json({ ok: true, ...state })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/prepare', upload.fields([
  { name: 'media', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const media = req.files?.media?.[0]
  const audio = req.files?.audio?.[0]
  if (!media) {
    res.status(400).json({ ok: false, error: 'Escolha um vídeo ou uma imagem' })
    return
  }
  const id = randomUUID()
  const workDir = join(tmpDir(), 'jobs', id)
  try {
    log('Convertendo para figurinha…')
    const result = await convertToSticker({
      mediaPath: media.path,
      mediaName: media.originalname,
      audioPath: audio?.path || null,
      workDir
    })
    const stickerBuf = await readFile(result.stickerPath)
    const job = {
      id,
      ...result,
      createdAt: Date.now()
    }
    jobs.set(id, job)
    log(`Figurinha pronta (${(result.stickerBytes / 1024).toFixed(1)} KB${result.audioPath ? `, áudio ${result.audioSeconds.toFixed(1)} s` : ''}).`)
    res.json({
      ok: true,
      id,
      isAnimated: result.isAnimated,
      stickerBytes: result.stickerBytes,
      audioSeconds: result.audioSeconds,
      hasAudio: Boolean(result.audioPath),
      warnings: result.warnings,
      preview: `data:image/webp;base64,${stickerBuf.toString('base64')}`,
      audioUrl: result.audioPath ? `/api/jobs/${id}/audio` : null
    })
  } catch (err) {
    log(`Falha na conversão: ${err.message}`)
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    const { id, to, alsoSilent } = req.body || {}
    const job = jobs.get(id)
    if (!job) {
      res.status(400).json({ ok: false, error: 'Prepare a figurinha antes de enviar' })
      return
    }
    log(`Enviando para ${to || 'o próprio número'}…`)
    const result = await wa.sendSticker({
      stickerPath: job.stickerPath,
      audioPath: job.audioPath,
      isAnimated: job.isAnimated,
      to,
      alsoSilent: Boolean(alsoSilent)
    })
    const sound = result.results.find((r) => r.kind === 'sound') || result.results.at(-1)
    if (sound?.proto?.hasAudioMessage) log('Enviado. O proto inclui audioMessage.')
    else if (job.audioPath) log('Enviado, mas o proto não veio com audioMessage.')
    else log('Enviado (figurinha sem áudio).')
    res.json({ ok: true, ...result })
  } catch (err) {
    log(`Falha no envio: ${err.message}`)
    res.status(500).json({ ok: false, error: err.message })
  }
})


app.get('/api/jobs/:id/audio', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job?.audioPath || !existsSync(job.audioPath)) {
    res.status(404).json({ ok: false, error: 'Áudio não encontrado' })
    return
  }
  res.setHeader('Content-Type', 'audio/ogg')
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(job.audioPath)
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegSafe() })
})

function ffmpegSafe() {
  try {
    return getFfmpegPath()
  } catch (err) {
    return { error: err.message }
  }
}

function openInBrowser(url) {
  const plat = process.platform
  const cmd = plat === 'win32'
    ? `cmd /c start "" "${url}"`
    : plat === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  exec(cmd, () => {})
}

await mkdir(tmpDir(), { recursive: true })

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`
  console.log(`Figurinha com Som em ${url}`)
  console.log(`Dados em ${dataDir()}`)
  if (typeof ffmpegSafe() === 'string') console.log(`FFmpeg: ${ffmpegSafe()}`)
  else console.warn('FFmpeg não encontrado. Rode npm run fetch-ffmpeg.')
  if (openBrowser) openInBrowser(url)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
