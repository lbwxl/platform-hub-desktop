import { readFile } from 'node:fs/promises'

const runtime = await readFile(new URL('../packages/kuaishou-hook/dist/runtime.js', import.meta.url), 'utf8')
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
function evaluate(expression) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('快手 Hook 重载超时')), 30_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression } }))
  })
}

await evaluate(runtime)
await new Promise((resolve) => setTimeout(resolve, 1200))
const result = await evaluate(`(() => {
  let sdk = window.__chat_sdk
  try {
    for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk
  } catch (_) {}
  return {
    hookVersion: window.__platformHub?.__version,
    authenticated: false,
    sdkNewMessageListeners: Number(sdk?.listenerCount?.('system.session.newMessageFromBuyer') || 0),
    sdkMessagesUpdateListeners: Number(sdk?.esImSdk?.listenerCount?.('messagesUpdate') || 0),
  }
})()`)
result.authenticated = (await evaluate('window.__platformHub?.getAuthState?.()'))?.authenticated === true
console.log(JSON.stringify(result, null, 2))
socket.close()
