const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('抖店订单模块诊断超时')), 25_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    returnByValue: true,
    expression: `(() => {
      const results = []
      const roots = []
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!/(webpack|chunk|loadable)/i.test(key)) continue
        let value
        try { value = window[key] } catch (_) { continue }
        if (Array.isArray(value)) roots.push({ key, value })
      }
      const patterns = [
        /latest.{0,30}order/i,
        /recent.{0,30}order/i,
        /order.{0,30}(?:list|query|search|detail)/i,
        /(?:list|query|search).{0,30}order/i,
        /shop_order_id/i,
        /\u6700\u65b0\u8ba2\u5355/i,
        /\u5f85\u53d1\u8d27/i,
      ]
      let visited = 0
      for (const root of roots) {
        for (const chunk of root.value.slice(-500)) {
          const moduleMap = Array.isArray(chunk) ? chunk[1] : null
          if (!moduleMap || typeof moduleMap !== 'object') continue
          for (const [moduleId, factory] of Object.entries(moduleMap)) {
            if (visited >= 1800 || results.length >= 120) break
            visited += 1
            if (typeof factory !== 'function') continue
            let source = ''
            try { source = String(factory) } catch (_) { continue }
            const match = patterns.map((pattern) => source.search(pattern)).find((index) => index >= 0)
            if (match == null || match < 0) continue
            const start = Math.max(0, match - 1000)
            const end = Math.min(source.length, match + 5000)
            const snippet = source.slice(start, end).replace(/(token|cookie|authorization|password|secret)\s*[:=]\s*["'][^"']+["']/gi, '$1:"[redacted]"')
            results.push({ root: root.key, moduleId, sourceLength: source.length, snippet })
          }
          if (visited >= 1800 || results.length >= 120) break
        }
      }
      return { roots: roots.map((item) => ({
        key: item.key,
        chunks: item.value.length,
        pushSource: String(item.value.push).slice(0, 3000),
        chunkShapes: item.value.slice(-3).map((chunk) => ({ type: typeof chunk, array: Array.isArray(chunk), length: chunk?.length, keys: chunk && typeof chunk === 'object' ? Object.keys(chunk).slice(0, 30) : [] })),
      })), visited, results }
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
