const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 0
function evaluate(expression) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 30_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer); socket.removeEventListener('message', listener)
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression } }))
  })
}
const result = await evaluate(`(async () => {
  const accounts = await window.platformApi.accounts.list()
  const account = accounts.find((item) => item.platform === 'douyin-shop') || accounts[0]
  if (!account) return { accounts, error: '没有账号' }
  const sessions = await window.platformApi.sessions(account.id)
  const testSession = sessions.find((item) => item.title === '.ai') || sessions[0]
  const messages = testSession ? await window.platformApi.messages(account.id, testSession.id) : []
  const products = await window.platformApi.collectProducts(account.id)
  const latestAccount = (await window.platformApi.accounts.list()).find((item) => item.id === account.id) || account
  return {
    account: { platform: latestAccount.platform, connected: latestAccount.connected, authenticated: latestAccount.authenticated },
    sessions: sessions.map((item) => ({ id: item.id, title: item.title, unread: item.unread, lastMessage: item.lastMessage })),
    testMessages: messages.slice(-12).map((item) => ({ senderName: item.senderName, content: item.content, type: item.type, isMine: item.isMine, timestamp: item.timestamp })),
    products: products.map((item) => ({ id: item.id, goodsId: item.goodsId, name: item.name, price: item.price, stockQuantity: item.stockQuantity, status: item.status }))
  }
})()`)
console.log(JSON.stringify(result, null, 2))
socket.close()
