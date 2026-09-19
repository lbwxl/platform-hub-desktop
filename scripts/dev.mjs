import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
let electronPath = ''
try { electronPath = String(require('electron')).trim() } catch {}
const sharedElectron = 'D:\\code\\aichatclient\\node_modules\\electron\\dist\\electron.exe'
if (!existsSync(electronPath) && existsSync(sharedElectron)) electronPath = sharedElectron
if (!existsSync(electronPath)) throw new Error('未找到 Electron，请先执行 pnpm install')

const cli = resolve('node_modules/electron-vite/bin/electron-vite.js')
const child = spawn(process.execPath, [cli, 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_EXEC_PATH: electronPath },
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code) => process.exit(code ?? 1))
