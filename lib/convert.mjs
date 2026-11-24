import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { probe, runFfmpeg } from './ffmpeg.mjs'

const MAX_ANIMATED_BYTES = 500 * 1024
const MAX_STATIC_BYTES = 100 * 1024
const MAX_SECONDS = 10

const STILL_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.heic', '.heif'])
const ANIM_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.gif', '.m4v', '.3gp'])

function extOf(name = '') {
  const m = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/)
  return m ? m[1] : ''
}

function padFilter() {
  return 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:white,setsar=1'
}

async function encodeStaticWebp(input, output) {
  const qualities = [80, 70, 60, 50, 40, 30]
  let lastSize = 0
  for (const q of qualities) {
    await runFfmpeg([
      '-hide_banner', '-y', '-i', input,
      '-vf', padFilter(),
      '-frames:v', '1',
      '-c:v', 'libwebp',
      '-lossless', '0',
      '-compression_level', '5',
      '-q:v', String(q),
      output
    ])
    lastSize = (await stat(output)).size
    if (lastSize <= MAX_STATIC_BYTES) return lastSize
  }
  return lastSize
}

async function encodeAnimatedWebp(input, output, duration) {
  const t = Math.min(duration > 0 ? duration : MAX_SECONDS, MAX_SECONDS)
  const attempts = [
    { q: 80, fps: 20 },
    { q: 70, fps: 16 },
    { q: 60, fps: 12 },
    { q: 50, fps: 10 },
    { q: 40, fps: 8 },
    { q: 30, fps: 6 }
  ]
  let lastSize = 0
  for (const { q, fps } of attempts) {
    await runFfmpeg([
      '-hide_banner', '-y', '-i', input,
      '-t', t.toFixed(3),
      '-vf', `${padFilter()},fps=${fps},format=yuv420p`,
      '-an',
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-compression_level', '5',
      '-q:v', String(q),
      '-loop', '0',
      '-preset', 'picture',
      output
    ])
    lastSize = (await stat(output)).size
    if (lastSize <= MAX_ANIMATED_BYTES) return lastSize
  }
  return lastSize
}

async function encodeAudio(input, output) {
  await runFfmpeg([
    '-hide_banner', '-y', '-i', input,
    '-t', String(MAX_SECONDS),
    '-vn',
    '-c:a', 'libopus',
    '-ac', '1',
    '-ar', '48000',
    '-b:a', '64k',
    '-avoid_negative_ts', 'make_zero',
    output
  ])
  return (await stat(output)).size
}

/**
 * Converte vídeo/imagem (+ áudio opcional) para figurinha WhatsApp + OGG Opus.
 */
export async function convertToSticker({ mediaPath, mediaName, audioPath, workDir }) {
  await mkdir(workDir, { recursive: true })
  const warnings = []
  const info = await probe(mediaPath)
  const ext = extOf(mediaName || mediaPath)
  let isAnimated = ANIM_EXT.has(ext)
  if (ext === '.webp' || ext === '.gif') {
    isAnimated = info.duration > 0.2 || (info.hasVideo && info.duration !== 0)
  }
  if (STILL_EXT.has(ext)) isAnimated = false
  if (!isAnimated && !STILL_EXT.has(ext) && (info.duration > 0.2) && info.hasVideo) {
    isAnimated = true
  }

  const stickerPath = join(workDir, 'sticker.webp')
  let stickerBytes
  if (isAnimated) {
    stickerBytes = await encodeAnimatedWebp(mediaPath, stickerPath, info.duration)
    if (stickerBytes > MAX_ANIMATED_BYTES) {
      warnings.push(`A figurinha animada ficou com ${(stickerBytes / 1024).toFixed(0)} KB (limite 500 KB). Pode ser recusada.`)
    }
    if (info.duration > MAX_SECONDS) {
      warnings.push(`O vídeo tinha ${info.duration.toFixed(1)} s; usei só os primeiros ${MAX_SECONDS} s.`)
    }
  } else {
    stickerBytes = await encodeStaticWebp(mediaPath, stickerPath)
    if (stickerBytes > MAX_STATIC_BYTES) {
      warnings.push(`A figurinha estática ficou com ${(stickerBytes / 1024).toFixed(0)} KB (limite 100 KB). Pode ser recusada.`)
    }
  }

  let outAudio = null
  let audioSeconds = 0
  const audioSource = audioPath || (info.hasAudio ? mediaPath : null)
  if (audioSource) {
    const ogg = join(workDir, 'sound.ogg')
    try {
      await encodeAudio(audioSource, ogg)
      const ainfo = await probe(ogg)
      audioSeconds = ainfo.duration || 0
      if (audioSeconds > 0.05) {
        outAudio = ogg
        if (ainfo.duration > MAX_SECONDS + 0.05) {
          warnings.push(`O áudio tinha mais de ${MAX_SECONDS} s; recortei no limite.`)
        }
      } else {
        warnings.push('O áudio ficou vazio e foi ignorado.')
      }
    } catch (err) {
      warnings.push(`Não deu para aproveitar o áudio: ${err.message}`)
    }
  } else {
    warnings.push('Sem faixa de áudio: a figurinha vai sair muda, a menos que você envie um som à parte.')
  }

  return {
    stickerPath,
    audioPath: outAudio,
    isAnimated,
    stickerBytes,
    audioSeconds,
    sourceDuration: info.duration,
    sourceHasAudio: info.hasAudio,
    width: 512,
    height: 512,
    warnings
  }
}
