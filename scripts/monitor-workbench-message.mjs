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
  const timer = setTimeout(() => reject(new Error('等待买家消息超时')), 6 * 60_000)
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
      expression: `new Promise((resolve) => {
        let finished = false
        const finish = (value) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          stop?.()
          resolve(value)
        }
        const stop = window.platformApi.onEvent((event) => {
          if (event?.platform !== 'douyin-shop' || event?.type !== 'message') return
          const message = event.payload || {}
          finish({
            received: true,
            sessionId: String(message.sessionId || ''),
            messageId: String(message.id || ''),
            type: String(message.type || ''),
            content: String(message.content || ''),
            timestamp: Number(message.timestamp || event.timestamp || 0),
          })
        })
        const timer = setTimeout(() => finish({ received: false }), 5 * 60 * 1000)
      })`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
