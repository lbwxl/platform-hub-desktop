const cdpPort = process.env.PLATFORM_HUB_CDP_PORT || '9333'
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('打开快手页面超时')), 30_000)
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
      const platforms = await window.platformApi.platforms.list()
      if (!platforms.some((item) => item.id === 'kuaishou-shop')) throw new Error('快手小店插件尚未注册')
      const accounts = await window.platformApi.accounts.list()
      let account = accounts.find((item) => item.platform === 'kuaishou-shop')
      if (!account) account = await window.platformApi.accounts.add({ platform: 'kuaishou-shop', label: '快手小店测试账号' })
      account = await window.platformApi.accounts.open(account.id)
      return { account, platforms }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
