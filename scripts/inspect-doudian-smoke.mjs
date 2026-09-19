const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店客服页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  const timer = setTimeout(() => reject(new Error('抖店只读诊断超时')), 20_000)
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
        const sizeOf = (value) => {
          if (!value) return 0
          if (Array.isArray(value)) return value.length
          if (Number.isFinite(value.size)) return Number(value.size)
          try { return Object.keys(value).length } catch (_) { return 0 }
        }
        const store = window.ss?._frontStore
        const info = store?.conversationsInfo
        const im = window.__mona_pigeon_event?.globalStore?.data?.initContextData?.im
        const sourceNames = [
          'unClosedConversations', 'closedConversations', 'normalCurrentConversations',
          'platformMessageConversations', 'conversationMap', 'conversations',
          'allConversations', 'currentConversations', 'messagesByConversationId',
        ]
        const sources = Object.fromEntries(sourceNames.map((name) => [name, sizeOf(info?.[name])]))
        const api = window.__platformHub
        const auth = await api?.getAuthState?.()
        const sessions = await api?.listSessions?.()
        return {
          url: location.origin + location.pathname,
          hookVersion: api?.__version || '',
          authenticated: auth?.authenticated === true,
          hasFrontStore: Boolean(store),
          hasConversationsInfo: Boolean(info),
          conversationMembers: info ? Object.getOwnPropertyNames(info).slice(0, 160) : [],
          relevantStoreMembers: store ? Object.getOwnPropertyNames(store).filter((name) => /(conversation|session|message|talker|buyer|chat)/i.test(name)).slice(0, 160) : [],
          sources,
          hookSessionCount: Array.isArray(sessions) ? sessions.length : -1,
          messageStreams: {
            message: typeof im?._message$?.subscribe === 'function',
            upsert: typeof im?._messageUpsert$?.subscribe === 'function',
            batch: typeof im?._batchUpsert$?.subscribe === 'function',
          },
        }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
