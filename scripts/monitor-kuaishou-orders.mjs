const mode = process.argv[2] || 'read'
if (!['arm', 'read', 'dispose'].includes(mode)) throw new Error('模式必须是 arm、read 或 dispose')

const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到平台 Hook 工作台 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手订单监控操作超时')), 30_000)
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
      const mode = ${JSON.stringify(mode)}
      const summarizeSync = (sync) => ({
        authoritative: sync?.authoritative === true,
        source: String(sync?.source || 'none'),
        orderCount: Array.isArray(sync?.orders) ? sync.orders.length : 0,
        orders: Array.isArray(sync?.orders) ? sync.orders.slice(0, 20).map((order) => ({
          status: String(order?.status || ''),
          totalAmount: order?.totalAmount,
          quantity: order?.quantity,
          productName: String(order?.productName || ''),
        })) : [],
      })
      const fingerprint = (sync) => JSON.stringify((sync?.orders || []).map((order) => [order?.orderId, order?.status]).sort())

      if (mode === 'arm') {
        window.__kuaishouOrderMonitor?.dispose?.()
        const api = window.platformApi
        if (typeof api?.syncOrders !== 'function') throw new Error('宿主尚未加载 syncOrders，请重启应用')
        const accounts = await api.accounts.list()
        const account = accounts.find((item) => item.platform === 'kuaishou-shop')
        if (!account) throw new Error('未找到快手小店账号')
        const sessions = await api.sessions(account.id)
        const session = sessions.find((item) => item.title === '拾一见月') || sessions[0]
        if (!session) throw new Error('未找到可用于订单验证的快手会话')
        const baseline = await api.syncOrders(account.id, session.id)
        const changes = []
        const events = []
        let lastFingerprint = fingerprint(baseline)
        let syncing = false
        const stopEvents = api.onEvent((event) => {
          if (event.accountId !== account.id || !['message', 'order'].includes(event.type)) return
          const payload = event.payload || {}
          const order = event.type === 'order' ? payload.order : payload.order
          if (!order) return
          if (events.length >= 40) events.shift()
          events.push({
            eventType: event.type,
            timestamp: Number(event.timestamp || Date.now()),
            status: String(order.status || ''),
            totalAmount: order.totalAmount,
            quantity: order.quantity,
            productName: String(order.productName || ''),
          })
        })
        const timer = setInterval(async () => {
          if (syncing) return
          syncing = true
          try {
            const sync = await api.syncOrders(account.id, session.id)
            const nextFingerprint = fingerprint(sync)
            if (nextFingerprint !== lastFingerprint) {
              lastFingerprint = nextFingerprint
              if (changes.length >= 40) changes.shift()
              changes.push({ timestamp: Date.now(), ...summarizeSync(sync) })
            }
          } catch (error) {
            if (changes.length >= 40) changes.shift()
            changes.push({ timestamp: Date.now(), error: String(error?.message || error) })
          } finally {
            syncing = false
          }
        }, 800)
        window.__kuaishouOrderMonitor = {
          accountId: account.id,
          sessionId: session.id,
          sessionTitle: session.title,
          armedAt: Date.now(),
          baseline: summarizeSync(baseline),
          changes,
          events,
          dispose: () => { clearInterval(timer); stopEvents?.() },
        }
      }

      const monitor = window.__kuaishouOrderMonitor
      const result = monitor ? {
        armed: true,
        armedAt: monitor.armedAt,
        sessionTitle: monitor.sessionTitle,
        baseline: monitor.baseline,
        changes: monitor.changes.slice(),
        events: monitor.events.slice(),
      } : { armed: false, changes: [], events: [] }
      if (mode === 'dispose' && monitor) {
        monitor.dispose?.()
        delete window.__kuaishouOrderMonitor
        result.armed = false
      }
      return result
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
