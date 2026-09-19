const port = process.env.PLATFORM_HUB_CDP_PORT || '9333'
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
const target = targets.find((item) => /jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let id = 0
function evaluate(expression) {
  const requestId = ++id
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== requestId) return
      clearTimeout(timeout)
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

const result = await evaluate(`(() => {
  const standard = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)))
  const output = []
  for (const key of Object.getOwnPropertyNames(window)) {
    if (standard.has(key) || key === '__platformHub') continue
    let value
    try { value = window[key] } catch (_) { continue }
    if (!value || !['object', 'function'].includes(typeof value)) continue
    const keys = []
    try {
      for (const name of Object.getOwnPropertyNames(value).slice(0, 300)) {
        let type = 'unknown'
        try { type = typeof value[name] } catch (_) {}
        if (type === 'function' || /(chat|message|session|conversation|product|goods|order|shop|send|login|user|sdk|api|client|store)/i.test(name)) keys.push(name + ':' + type)
      }
    } catch (_) {}
    if (keys.length || /(chat|message|pigeon|dou|shop|goods|product|sdk|api|store|runtime|webpack)/i.test(key)) output.push({ key, type: typeof value, members: keys.slice(0, 100) })
  }
  return { url: location.origin + location.pathname, entries: output.slice(0, 200) }
})()`)

console.log(JSON.stringify(result, null, 2))
socket.close()
