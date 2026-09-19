import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const outputPath = resolve(process.argv[2] || 'artifacts/workbench.png')
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
function command(method, params = {}) {
  const id = ++nextId
  return new Promise((resolveCommand, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message))
      else resolveCommand(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await command('Runtime.evaluate', {
  awaitPromise: true,
  expression: `(async () => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('刷新会话'))
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 2500))
  })()`,
})
const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true })
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'))
console.log(outputPath)
socket.close()
