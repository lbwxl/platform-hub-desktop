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
  const cache = JSON.parse(localStorage.getItem('GOODS_SWR_CACHE_V1') || '{}')
  const key = Object.keys(cache).find((item) => item.includes('/product/tproduct/list\"'))
  const value = key ? cache[key] : null
  const describe = (item, depth = 0) => {
    if (depth > 5 || item == null) return item
    if (Array.isArray(item)) return { type: 'array', length: item.length, sample: item.slice(0, 2).map((entry) => describe(entry, depth + 1)) }
    if (typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).slice(0, 100).map(([name, entry]) => [name, describe(entry, depth + 1)]))
  }
  return { key, value: describe(value) }
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
