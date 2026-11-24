#!/usr/bin/env node
/** Baixa o binário do FFmpeg do release oficial do pacote ffmpeg-static. */
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)
const VERSION = 'b6.1.1'
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}`

function target({ platform = process.platform, arch = process.arch } = {}) {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const asset = platform === 'win32'
    ? `ffmpeg-${platform}-${arch}.gz`
    : `ffmpeg-${platform}-${arch}`
  return { exe, asset, gzip: platform === 'win32' || asset.endsWith('.gz') }
}

async function destDir() {
  try {
    const pkg = require.resolve('ffmpeg-static/package.json')
    return dirname(pkg)
  } catch {
    return join(process.cwd(), 'node_modules', 'ffmpeg-static')
  }
}

export async function fetchFfmpeg(opts = {}) {
  const { exe, asset } = target(opts)
  const dir = await destDir()
  await mkdir(dir, { recursive: true })
  const out = join(dir, exe)
  const url = `${BASE}/${asset}`
  console.log(`Baixando ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Falha ao baixar FFmpeg: ${res.status} ${res.statusText}`)
  const tmp = join(dir, `${exe}.partial`)
  const file = createWriteStream(tmp)
  const body = Readable.fromWeb(res.body)
  if (asset.endsWith('.gz')) {
    await pipeline(body, createGunzip(), file)
  } else {
    await pipeline(body, file)
  }
  const { rename } = await import('node:fs/promises')
  await rename(tmp, out)
  if (process.platform !== 'win32') await chmod(out, 0o755)
  console.log(`OK: ${out}`)
  return out
}

const isMain = process.argv[1] && process.argv[1].endsWith('fetch-ffmpeg.mjs')
if (isMain) {
  fetchFfmpeg().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
