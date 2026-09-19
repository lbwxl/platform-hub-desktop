const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /fxg\.jinritemai\.com\/ffa\/g\/list/i.test(item.url))
if (!target) throw new Error('未找到抖店商品管理 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  const output = {}
  for (const key of Object.keys(localStorage).filter((key) => /(goods|product|swr|cache)/i.test(key))) {
    const raw = localStorage.getItem(key)
    let value
    try { value = JSON.parse(raw) } catch (_) {}
    output[key] = {
      length: raw?.length || 0,
      type: Array.isArray(value) ? 'array' : typeof value,
      keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 100) : [],
      preview: raw?.slice(0, 500),
    }
  }
  return output
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
