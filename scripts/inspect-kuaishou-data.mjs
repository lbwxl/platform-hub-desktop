const buyerId = process.argv[2] || '5179373322'
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手数据诊断超时')), 30_000)
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
      try {
        for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk
      } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }
      const request = sdk.commonRequest
      const safeError = (error) => {
        const output = { text: String(error?.message || error) }
        try {
          for (const key of Object.getOwnPropertyNames(error || {}).slice(0, 60)) {
            const value = error[key]
            if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value
          }
          const data = error?.response?.data || error?.data
          if (data && typeof data === 'object') output.data = JSON.parse(JSON.stringify(data))
        } catch (_) {}
        return output
      }
      const call = async (method, params) => {
        try {
          const value = await request[method](params)
          return { ok: true, value: JSON.parse(JSON.stringify(value?.data || value)) }
        } catch (error) {
          return { ok: false, error: safeError(error) }
        }
      }
      const buyerId = ${JSON.stringify(buyerId)}
      const [orders, goods, staff] = await Promise.all([
        (async () => {
          try {
            const value = await sdk.https.post('/gateway/business/cs/order/list', { buyerId, itemTitle: '', limit: 20, offset: 0, orderStatus: 0 })
            return { ok: true, value: JSON.parse(JSON.stringify(value?.data || value)) }
          } catch (error) { return { ok: false, error: safeError(error) } }
        })(),
        call('getGoodsListNew', { buyerId, limit: 20, offset: 0, viewTab: 1, searchKeyword: '' }),
        call('getOnlineCsList', {}),
      ])
      return {
        sources: {
          orderSearch: String(request.orderSearch || '').slice(0, 6000),
          getGoodsListNew: String(request.getGoodsListNew || '').slice(0, 6000),
          getOnlineCsList: String(request.getOnlineCsList || '').slice(0, 6000),
          batchTransferSessions: String(request.batchTransferSessions || '').slice(0, 6000),
        },
        orders,
        goods,
        staff,
      }
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
