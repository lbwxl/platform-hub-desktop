const sessionId = process.argv.find((value) => value.startsWith('--session='))?.slice('--session='.length) || ''
const content = process.argv.find((value) => value.startsWith('--content='))?.slice('--content='.length) || ''
if (!sessionId || !content) throw new Error('缺少测试会话或消息内容')

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
  const timer = setTimeout(() => reject(new Error('卖家回复验收超时')), 30_000)
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
        if (!account) return { success: false, error: 'douyin-account-not-found' }
        const result = await window.platformApi.sendMessage(account.id, ${JSON.stringify(sessionId)}, ${JSON.stringify(content)})
        await new Promise((resolve) => setTimeout(resolve, 800))
        const messages = await window.platformApi.messages(account.id, ${JSON.stringify(sessionId)})
        const echoed = messages.some((message) => message.isMine === true && message.content === ${JSON.stringify(content)})
        return { success: result?.success === true, echoed, messageId: String(result?.messageId || '') }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
