const since = Number(process.argv[2] || Date.now() - 15 * 60_000)
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到平台 Hook 工作台 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('抖店订单历史诊断超时')), 30_000)
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
      const since = ${JSON.stringify(since)}
      const accounts = await window.platformApi.accounts.list()
      const account = accounts.find((item) => item.platform === 'douyin-shop')
      if (!account) return { error: 'douyin-account-not-found' }
      const sessions = await window.platformApi.sessions(account.id)
      const output = []
      for (const session of sessions.slice(0, 100)) {
        let messages = []
        try { messages = await window.platformApi.messages(account.id, session.id) } catch (_) {}
        const recent = messages.filter((message) => Number(message.timestamp || 0) >= since || message.type === 'order').map((message) => ({
          id: message.id,
          type: message.type,
          isMine: message.isMine,
          timestamp: message.timestamp,
          senderId: message.senderId,
          hasOrder: Boolean(message.order),
          order: message.order ? {
            orderId: message.order.orderId,
            skuOrderId: message.order.skuOrderId,
            status: message.order.status,
            totalAmount: message.order.totalAmount,
            quantity: message.order.quantity,
            productId: message.order.productId,
            productName: message.order.productName,
          } : undefined,
        }))
        if (recent.length || Number(session.updatedAt || 0) >= since) {
          output.push({ session: { id: session.id, title: session.title, updatedAt: session.updatedAt }, messages: recent })
        }
      }
      return { since, sessions: output }
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
