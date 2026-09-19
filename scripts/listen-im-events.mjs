const durationMs = Number(process.argv[2] || 20_000)
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), durationMs + 10_000)
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
      const durationMs = ${JSON.stringify(durationMs)}
      const im = window.__mona_pigeon_event?.globalStore?.data?.initContextData?.im
      const store = window.ss?._frontStore
      if (!im || !store) throw new Error('官方 IM runtime 尚未就绪')
      const conversations = [
        ...(store.conversationsInfo?.unClosedConversations || []),
        ...(store.conversationsInfo?.closedConversations || []),
      ]
      const testConversation = conversations.find((item) => String(item?.rawExt?.fusion_uname || '').toLowerCase() === '.ai')
      if (!testConversation?.id) throw new Error('未找到 .ai 会话')

      const events = []
      const visit = (value, stream) => {
        if (!value) return
        if (Array.isArray(value)) return value.forEach((item) => visit(item, stream))
        for (const key of ['messages', 'items', 'list']) {
          if (Array.isArray(value?.[key])) value[key].forEach((item) => visit(item, stream))
        }
        const item = value?.message || value?.data || value?.payload || value
        const conversationId = String(item?.conversationId || item?.originConversationId || item?.securityConversationId || '')
        if (conversationId !== String(testConversation.id)) return
        const id = String(item?.serverId || item?.messageId || item?.clientId || item?.id || '')
        if (!id || events.some((event) => event.id === id)) return
        events.push({
          id,
          stream,
          content: String(item?.content || item?.text || item?.ext?.cs_special_content || ''),
          type: String(item?.ext?.type || item?.type || ''),
          createTime: Number(item?.createTime || item?.timestamp || Date.now()),
          senderRole: String(item?.ext?.sender_role || item?.ext?.['s:sender_biz_role'] || ''),
        })
      }
      const subscriptions = []
      try {
        for (const name of ['_message$', '_messageUpsert$', '_batchUpsert$']) {
          if (typeof im[name]?.subscribe === 'function') subscriptions.push(im[name].subscribe((value) => visit(value, name)))
        }
        await new Promise((resolve) => setTimeout(resolve, durationMs))
      } finally {
        subscriptions.forEach((subscription) => subscription?.unsubscribe?.())
      }
      return events.map(({ id, ...event }) => event)
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
