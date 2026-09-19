const listenMs = Math.max(0, Number(process.argv[2] || 0))
const expectedMessages = Math.max(1, Number(process.argv[3] || 1))
const cdpPort = process.env.PLATFORM_HUB_CDP_PORT || '9333'
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到平台 Hook 工作台 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手公开 API 验证超时')), Math.max(30_000, listenMs + 30_000))
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
      const listenMs = ${JSON.stringify(listenMs)}
      const expectedMessages = ${JSON.stringify(expectedMessages)}
      const api = window.platformApi
      const accounts = await api.accounts.list()
      const account = accounts.find((item) => item.platform === 'kuaishou-shop')
      if (!account) throw new Error('未找到快手小店账号')

      const events = []
      let finishListening
      const eventDone = new Promise((resolve) => { finishListening = resolve })
      const dispose = listenMs > 0 ? api.onEvent((event) => {
        if (event.accountId !== account.id || event.type !== 'message') return
        const message = event.payload || {}
        events.push({
          id: String(message.id || ''),
          sessionId: String(message.sessionId || ''),
          senderName: String(message.senderName || ''),
          contentPreview: String(message.content || '').slice(0, 80),
          messageType: String(message.type || ''),
          isMine: message.isMine === true,
          timestamp: Number(message.timestamp || event.timestamp || 0),
          hasProduct: Boolean(message.product),
          hasOrder: Boolean(message.order),
        })
        if (events.length >= expectedMessages) finishListening()
      }) : () => undefined

      try {
        const status = await api.status(account.id)
        const sessions = await api.sessions(account.id)
        const selected = sessions[0]
        const [messages, products, orders] = await Promise.all([
          selected ? api.messages(account.id, selected.id) : [],
          api.collectProducts(account.id),
          selected ? api.orders(account.id, selected.id) : [],
        ])
        if (listenMs > 0 && events.length < expectedMessages) {
          await Promise.race([eventDone, new Promise((resolve) => setTimeout(resolve, listenMs))])
        }
        const typeCounts = messages.reduce((counts, message) => {
          counts[message.type] = (counts[message.type] || 0) + 1
          return counts
        }, {})
        return {
          status: { connected: status.connected, authenticated: status.authenticated, url: status.url },
          sessionCount: sessions.length,
          selectedSession: selected ? { title: selected.title, unread: selected.unread } : null,
          history: { count: messages.length, typeCounts },
          products: products.slice(0, 3).map((product) => ({
            goodsId: product.goodsId,
            name: product.name,
            price: product.price,
            stockQuantity: product.stockQuantity,
          })),
          orderCount: orders.length,
          events,
        }
      } finally {
        dispose()
      }
    })()`,
  },
}))

if (listenMs > 0) console.log(`LISTENING kuaishou-shop for ${listenMs}ms, waiting for ${expectedMessages} message event(s)`) 
console.log(JSON.stringify(await answer, null, 2))
socket.close()
