const targetId = process.argv[2]
if (!targetId) throw new Error('请提供快手会话 targetId')
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
function evaluate(expression, awaitPromise = true) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 15_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }))
  })
}

const sdkExpression = `(() => {
  if (window.__chat_sdk) return window.__chat_sdk
  try {
    for (let index = 0; index < Math.min(window.frames.length, 12); index += 1) {
      if (window.frames[index].__chat_sdk) return window.frames[index].__chat_sdk
    }
  } catch (_) {}
  return null
})()`

await evaluate(`(() => {
  const sdk = ${sdkExpression}
  if (!sdk) throw new Error('chat-sdk-not-found')
  const sessions = sdk.sessionModel?.sessionAllModel?.allSessionMap
  const session = typeof sessions?.get === 'function' ? sessions.get(${JSON.stringify(targetId)}) : sessions?.[${JSON.stringify(targetId)}]
  if (!session) throw new Error('session-not-found')
  sdk.chatWithTarget({ targetSession: session })
  return true
})()`, false)

await new Promise((resolve) => setTimeout(resolve, 2500))

const result = await evaluate(`(() => {
  const sdk = ${sdkExpression}
  const store = sdk?.currentSessionMessageListStore
  const describe = (value) => {
    if (!value || !['object', 'function'].includes(typeof value)) return null
    const result = []
    for (const owner of [value, Object.getPrototypeOf(value)]) {
      try {
        for (const key of Object.getOwnPropertyNames(owner || {}).slice(0, 300)) {
          if (key === 'constructor' || result.some((item) => item.key === key)) continue
          let type = 'unknown'; let arity
          try { type = typeof value[key]; if (type === 'function') arity = value[key].length } catch (_) {}
          result.push({ key, type, arity })
        }
      } catch (_) {}
    }
    return result
  }
  const safe = (value) => {
    if (!value || typeof value !== 'object') return value
    const output = {}
    for (const key of Object.getOwnPropertyNames(value).slice(0, 120)) {
      let child
      try { child = value[key] } catch (_) { continue }
      if (typeof child === 'function') continue
      if (child == null || ['string', 'number', 'boolean'].includes(typeof child)) output[key] = child
      else if (Array.isArray(child)) output[key] = { type: 'array', length: child.length }
      else output[key] = { type: child.constructor?.name || 'object', keys: Object.getOwnPropertyNames(child).slice(0, 60) }
    }
    return output
  }
  const values = (value) => {
    if (!value) return []
    if (Array.isArray(value)) return value
    try { if (typeof value.values === 'function') return Array.from(value.values()) } catch (_) {}
    try { return Object.values(value) } catch (_) { return [] }
  }
  const messages = values(store?.messages || store?.messageList || store?.msgList || store?.list || store?.currentMessages)
  return {
    targetId: ${JSON.stringify(targetId)},
    currentStore: safe(store),
    members: describe(store),
    messageCount: messages.length,
    sources: {
      chatWithTargetById: String(sdk?.chatWithTargetById || '').slice(0, 5000),
      chatWithTarget: String(sdk?.chatWithTarget || '').slice(0, 5000),
      createChatModel: String(sdk?.createChatModel || '').slice(0, 5000),
      createSessionModel: String(sdk?.createSessionModel || '').slice(0, 5000),
      sendTextMsg: String(sdk?.messageSender?.sendTextMsg || '').slice(0, 5000),
      sendImageMsg: String(sdk?.messageSender?.sendImageMsg || '').slice(0, 5000),
    },
    messages: messages.slice(-10).map((item) => ({
      item: safe(item),
      provider: safe(item?.provider),
      kMsg: safe(item?.kMsg),
      rawMsg: safe(item?.kMsg?.rawMsg),
      eContent: safe(item?.kMsg?.eContent),
    })),
  }
})()`)

console.log(JSON.stringify(result, null, 2))
socket.close()
