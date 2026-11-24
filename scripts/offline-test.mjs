#!/usr/bin/env node
/**
 * Offline test: convert a local video/image and build the sticker proto
 * without connecting to WhatsApp.
 *
 *   node scripts/offline-test.mjs /path/to/video.mp4
 */
import { mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateWAMessageContent } from 'plogme'
import { convertToSticker } from '../lib/convert.mjs'
import { getFfmpegPath } from '../lib/ffmpeg.mjs'
import { tmpDir } from '../lib/paths.mjs'

const input = process.argv[2]
if (!input || !existsSync(input)) {
  console.error('Usage: node scripts/offline-test.mjs /path/to/video-or-image')
  process.exit(1)
}

const logger = {
  level: 'silent',
  child() { return this },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
}
const fakeUpload = async () => ({
  mediaUrl: 'https://example.invalid/media',
  directPath: '/invalid'
})

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
  console.log('OK:', msg)
}

const ffmpeg = getFfmpegPath()
ok(existsSync(ffmpeg), `FFmpeg found: ${ffmpeg}`)

const workDir = join(tmpDir(), 'offline-test')
await mkdir(workDir, { recursive: true })
console.log('Converting', input)
const result = await convertToSticker({
  mediaPath: input,
  mediaName: input,
  workDir
})
ok(existsSync(result.stickerPath), `sticker generated (${(result.stickerBytes / 1024).toFixed(1)} KB)`)
ok(result.width === 512 && result.height === 512, '512×512')
if (result.isAnimated) {
  ok(result.stickerBytes <= 500 * 1024, 'animated ≤ 500 KB')
} else {
  ok(result.stickerBytes <= 100 * 1024, 'static ≤ 100 KB')
}

const silent = await generateWAMessageContent(
  { sticker: { url: result.stickerPath }, isAnimated: result.isAnimated },
  { upload: fakeUpload, logger }
)
ok(Boolean(silent.stickerMessage), 'silent proto has stickerMessage')
ok(!silent.stickerMessage.audioMessage, 'silent proto has no audioMessage')

if (result.audioPath) {
  ok((await stat(result.audioPath)).size > 1000, 'ogg extracted')
  ok(result.audioSeconds > 0 && result.audioSeconds <= 10.2, `audio ${result.audioSeconds.toFixed(2)} s`)
  const sound = await generateWAMessageContent(
    {
      sticker: { url: result.stickerPath },
      stickerAudio: { url: result.audioPath },
      isAnimated: result.isAnimated
    },
    { upload: fakeUpload, logger }
  )
  ok(Boolean(sound.stickerMessage), 'sound proto has stickerMessage')
  ok(Boolean(sound.stickerMessage.audioMessage), 'stickerMessage.audioMessage present')
  console.log('sticker mimetype:', sound.stickerMessage.mimetype)
  console.log('audio mimetype:', sound.stickerMessage.audioMessage.mimetype)
  console.log('isAnimated:', sound.stickerMessage.isAnimated)
}

if (result.warnings.length) console.log('warnings:', result.warnings)
console.log('\nOffline test finished. No WhatsApp socket was opened.')
