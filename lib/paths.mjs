import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = dirname(fileURLToPath(new URL('../server.mjs', import.meta.url)))

export function appDir() {
  return APP_DIR
}

/** Pasta de dados (auth, tmp). No zip do Windows, FIGURINHA_ROOT é a pasta do Iniciar.bat. */
export function dataDir() {
  const env = process.env.FIGURINHA_ROOT
  if (env) return env.replace(/[\\/]+$/, '')
  return APP_DIR
}

export function authDir() {
  return join(dataDir(), 'auth')
}

export function tmpDir() {
  return join(dataDir(), 'tmp')
}

export function publicDir() {
  return join(APP_DIR, 'public')
}
