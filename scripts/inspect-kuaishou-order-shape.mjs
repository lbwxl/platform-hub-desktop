const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手订单结构诊断超时')), 30_000)
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
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      let sdk = window.__chat_sdk
      try { for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }
      const sessions = await window.__platformHub.listSessions()
      const session = sessions.find((item) => item.title === '拾一见月') || sessions[0]
      if (!session) return { error: 'session-not-found' }
      const response = await sdk.https.post('/gateway/business/cs/order/list', { buyerId: session.id, itemTitle: '', limit: 20, offset: 0, orderStatus: 0 })
      const data = response?.data?.data || response?.data || response || {}
      const rows = data?.orderInfoList || data?.list || data?.items || []
      const sensitive = /(^id$|Id$|_id$|buyer|user|seller|shop|address|phone|mobile|receiver|recipient|contact|token|cookie|sign|header|url|image|pic|avatar)/i
      const relevant = /(status|state|amount|price|quantity|count|num|title|goods|product|item|payment|order|time|desc|sku)/i
      const describe = (value, depth = 0, seen = new Set()) => {
        if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return undefined
        seen.add(value)
        const output = { keys: [], values: {}, children: {} }
        let keys = []
        try { keys = Object.getOwnPropertyNames(value).slice(0, 160) } catch (_) { return output }
        output.keys = keys.filter((key) => !sensitive.test(key)).slice(0, 100)
        for (const key of keys) {
          if (sensitive.test(key) || !relevant.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (child == null || ['string', 'number', 'boolean'].includes(typeof child)) output.values[key] = child
          else if (typeof child === 'object') {
            const nested = describe(child, depth + 1, seen)
            if (nested) output.children[key] = nested
          }
        }
        return output
      }
      return {
        count: Array.isArray(rows) ? rows.length : 0,
        summaries: Array.isArray(rows) ? rows.slice(0, 3).map((row) => ({
          hasToJSON: typeof row?.toJSON === 'function',
          toJSONKeys: (() => { try { return typeof row?.toJSON === 'function' ? Object.keys(row.toJSON() || {}).slice(0, 80) : [] } catch (_) { return [] } })(),
          jsonKeys: (() => { try { return Object.keys(JSON.parse(JSON.stringify(row)) || {}).slice(0, 80) } catch (_) { return [] } })(),
          status: row?.orderBaseInfo?.status,
          orderStatusText: String(row?.orderBaseInfo?.orderStatusTag?.text || ''),
          payText: String(row?.orderBaseInfo?.payText || ''),
          itemTitle: String(row?.itemAndPriceInfo?.itemTitle || ''),
          itemPrice: row?.itemAndPriceInfo?.itemPrice,
          itemNum: row?.itemAndPriceInfo?.itemNum,
        })) : [],
        rows: Array.isArray(rows) ? rows.slice(0, 3).map((row) => describe(row)) : [],
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
