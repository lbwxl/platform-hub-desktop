const content = process.argv.slice(2).join(' ').trim() || 'Hook 联调测试：已收到消息，快手回复链路正常。'
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到平台 Hook 工作台 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手回复链路验证超时')), 30_000)
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
      const content = ${JSON.stringify(content)}
      const accounts = await window.platformApi.accounts.list()
      const account = accounts.find((item) => item.platform === 'kuaishou-shop')
      if (!account) throw new Error('未找到快手小店账号')
      const status = await window.platformApi.status(account.id)
      if (!status.authenticated) throw new Error('快手小店账号尚未登录')
      const sessions = await window.platformApi.sessions(account.id)
      const matches = sessions.filter((item) => item.title === '拾一见月')
      if (matches.length !== 1) throw new Error('“拾一见月”会话数量不是 1，已取消发送')
      const session = matches[0]
      const before = await window.platformApi.messages(account.id, session.id)
      const result = await window.platformApi.sendMessage(account.id, session.id, content)
      if (!result?.success) throw new Error(result?.error || '快手文本发送失败')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const after = await window.platformApi.messages(account.id, session.id)
      const sent = after.slice().reverse().find((message) => message.content === content && message.isMine === true)
      return {
        success: true,
        recipient: session.title,
        content,
        historyCountBefore: before.length,
        historyCountAfter: after.length,
        verifiedInHistory: Boolean(sent),
        messageType: sent?.type,
        isMine: sent?.isMine === true,
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
