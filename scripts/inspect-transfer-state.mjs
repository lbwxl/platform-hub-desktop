const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')
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
  const transfer = window.ss?._frontStore?.uiState?.chatRooms?.transferConv
  const inspect = (value) => {
    if (!value) return null
    const output = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      let item
      try { item = value[key] } catch (_) { continue }
      if (typeof item === 'function') output[key] = { type: 'function', arity: item.length, source: String(item).slice(0, 1200) }
      else if (item && typeof item === 'object') {
        let json
        try { json = JSON.parse(JSON.stringify(item)) } catch (_) {}
        output[key] = { type: Array.isArray(item) ? 'array' : 'object', keys: Object.keys(item).slice(0, 80), json }
      } else output[key] = { type: typeof item, value: item }
    }
    return output
  }
  return inspect(transfer)
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
