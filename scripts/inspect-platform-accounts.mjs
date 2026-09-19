const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到平台 Hook 工作台 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('读取平台账号超时')), 15_000)
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
      const openPlatform = ${JSON.stringify(process.argv.find((arg) => arg.startsWith('--open='))?.slice(7) || '')}
      const target = accounts.find((item) => item.platform === openPlatform)
      if (target) {
        await window.platformApi.accounts.open(target.id)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      const result = []
      for (const account of accounts) {
        let status = null
        try { status = await window.platformApi.status(account.id) } catch (_) {}
        result.push({ id: account.id, platform: account.platform, label: account.label, connected: status?.connected === true, authenticated: status?.authenticated === true, url: status?.url || account.url })
      }
      return result
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
