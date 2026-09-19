const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
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
    returnByValue: true,
    expression: `(() => {
      const opened = window.open('https://fxg.jinritemai.com/ffa/g/list?tab=all', 'platform-hub-products')
      return { opened: Boolean(opened) }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
