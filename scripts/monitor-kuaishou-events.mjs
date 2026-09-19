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
  const timer = setTimeout(() => reject(new Error('快手事件监控操作超时')), 30_000)
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
      if (mode === 'arm') {
        window.__kuaishouEventMonitor?.dispose?.()
        const accounts = await window.platformApi.accounts.list()
        const account = accounts.find((item) => item.platform === 'kuaishou-shop')
        if (!account) throw new Error('未找到快手小店账号')
        const events = []
        const dispose = window.platformApi.onEvent((event) => {
          if (event.accountId !== account.id || event.type !== 'message') return
          const message = event.payload || {}
          if (events.length >= 20) events.shift()
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
        })
        window.__kuaishouEventMonitor = { accountId: account.id, armedAt: Date.now(), events, dispose }
      }
      const monitor = window.__kuaishouEventMonitor
      const result = monitor ? { armed: true, armedAt: monitor.armedAt, events: monitor.events.slice() } : { armed: false, events: [] }
      if (mode === 'dispose' && monitor) {
        monitor.dispose?.()
        delete window.__kuaishouEventMonitor
        result.armed = false
      }
      return result
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
