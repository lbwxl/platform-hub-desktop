const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 20_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  const store = window.ss?._frontStore
  const conv = [...(store?.conversationsInfo?.unClosedConversations || []), ...(store?.conversationsInfo?.closedConversations || [])].find((item) => String(item?.rawExt?.fusion_uname || '').toLowerCase() === '.ai')
  const room = conv ? store?.uiState?.chatRooms?.getChatRoom?.(conv.id) : null
  const shape = (value) => {
    if (!value) return null
    const output = []
    let current = value
    for (let depth = 0; current && depth < 3; depth += 1) {
      output.push({ depth, members: Object.getOwnPropertyNames(current).map((name) => { let type = 'unknown'; let source; try { type = typeof value[name]; if (type === 'function') source = String(value[name]).slice(0, 1200) } catch (_) {} return { name, type, source } }) })
      current = Object.getPrototypeOf(current)
    }
    return output
  }
  return {
    roomTransfer: shape(room?.transferConv),
    roomInput: shape(room?.inputBox),
    globalTransfer: shape(store?.uiState?.chatRooms),
    serviceGroup: shape(store?.shopInfo),
    orderKeys: Object.keys(store || {}).filter((key) => /(order|refund|after|sale)/i.test(key)),
  }
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
