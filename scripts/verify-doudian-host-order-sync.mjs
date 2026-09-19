const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  const timer = setTimeout(() => reject(new Error('宿主订单同步验收超时')), 30_000)
  socket.addEventListener('message', function listener(event) {
    const message = JSON.parse(event.data)
    if (message.id !== id) return
    clearTimeout(timer)
    socket.removeEventListener('message', listener)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const accounts = await window.platformApi.accounts.list()
        const account = accounts.find((item) => item.platform === 'douyin-shop')
        if (!account) return { error: 'douyin-account-not-found' }
        const sessions = await window.platformApi.sessions(account.id)
        const session = sessions.find((item) => item.title === '.ai')
        if (!session) return { error: 'test-session-not-found' }
        const sync = await window.platformApi.syncOrders(account.id, session.id)
        return {
          authenticated: account.authenticated === true,
          sessionFound: true,
          authoritative: sync.authoritative === true,
          source: sync.source,
          orderCount: sync.orders?.length || 0,
          orders: (sync.orders || []).slice(0, 5).map((order) => ({ status: order.status, totalAmount: order.totalAmount, quantity: order.quantity, productName: order.productName })),
        }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
