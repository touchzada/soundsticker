import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export function getFfmpegPath() {
  if (process.env.FFMPEG_BIN && existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN
  }
  let packaged = null
  try {
    packaged = require('ffmpeg-static')
  } catch {
    packaged = null
  }
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    packaged,
    packaged && join(dirname(packaged), exe),
    join(appSibling(), 'bin', exe),
    join(appSibling(), exe)
  ].filter(Boolean)
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  throw new Error(
    'Não achei o FFmpeg. Rode `npm run fetch-ffmpeg` ou defina FFMPEG_BIN.'
  )
}

function appSibling() {
  return dirname(fileURLToPath(new URL('../server.mjs', import.meta.url)))
}

export function runFfmpeg(args, { timeoutMs = 120_000 } = {}) {
  const bin = getFfmpegPath()
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('FFmpeg estourou o tempo limite'))
    }, timeoutMs)
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr, code })
      else reject(new Error(`FFmpeg saiu com código ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

/** Usa `ffmpeg -i` (stderr) para inspecionar o arquivo. Não precisa de ffprobe. */
export async function probe(filePath) {
  const bin = getFfmpegPath()
  const { stderr } = await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-hide_banner', '-i', filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', () => resolve({ stderr })) // -i sem output sai != 0
  })
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  let duration = 0
  if (durationMatch) {
    duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
  }
  const hasAudio = /Stream #\d+:\d+.*?:\s*Audio:/.test(stderr)
  const hasVideo = /Stream #\d+:\d+.*?:\s*Video:/.test(stderr)
  const dim = stderr.match(/Video:.*?\s(\d{2,5})x(\d{2,5})/)
  return {
    duration,
    hasAudio,
    hasVideo,
    width: dim ? Number(dim[1]) : null,
    height: dim ? Number(dim[2]) : null,
    raw: stderr
  }
}
