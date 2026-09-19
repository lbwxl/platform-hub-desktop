const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 60_000)
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
      const accounts = await window.platformApi.accounts.list()
      const account = accounts.find((item) => item.platform === 'douyin-shop')
      if (!account) throw new Error('未找到抖店账号')
      const sessions = await window.platformApi.sessions(account.id)
      const session = sessions.find((item) => item.title === '.ai')
      if (!session) throw new Error('未找到 .ai 测试会话')
      const canvas = document.createElement('canvas')
      canvas.width = 360
      canvas.height = 120
      const context = canvas.getContext('2d')
      context.fillStyle = '#f5f7fb'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#2d62f3'
      context.fillRect(0, 0, 12, canvas.height)
      context.fillStyle = '#17233b'
      context.font = 'bold 24px sans-serif'
      context.fillText('Hook image test', 36, 56)
      context.fillStyle = '#6d788b'
      context.font = '16px sans-serif'
      context.fillText('CDP + window runtime', 36, 86)
      const result = await window.platformApi.sendFile(account.id, session.id, canvas.toDataURL('image/png'), 'hook-image-test.png')
      return { success: result?.success === true, error: result?.error, errorCode: result?.errorCode }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
