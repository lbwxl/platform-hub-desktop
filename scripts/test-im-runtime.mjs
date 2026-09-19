const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 15_000)
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
      const ctx = window.__mona_pigeon_event?.globalStore?.data?.initContextData
      const store = window.ss?._frontStore
      const conversations = [
        ...(store?.conversationsInfo?.unClosedConversations || []),
        ...(store?.conversationsInfo?.closedConversations || []),
      ]
      const conversation = conversations.find((item) => String(item?.rawExt?.fusion_uname || '').toLowerCase() === '.ai')
      if (!ctx?.im || !conversation?.id) throw new Error('未找到 .ai 会话或官方 IM runtime')

      const events = []
      const summarize = (value) => {
        const item = value?.message || value?.data || value?.payload || value
        return {
          keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 40) : [],
          id: String(item?.serverId || item?.messageId || item?.clientId || item?.id || ''),
          conversationId: String(item?.conversationId || ''),
          content: String(item?.content || item?.text || ''),
          sender: String(item?.sender || item?.senderId || ''),
          type: String(item?.ext?.type || item?.type || ''),
        }
      }
      const subscriptions = []
      for (const name of ['_message$', '_messageUpsert$', '_batchUpsert$']) {
        const stream = ctx.im[name]
        if (typeof stream?.subscribe !== 'function') continue
        subscriptions.push(stream.subscribe((value) => events.push({ stream: name, value: summarize(value) })))
      }

      let sendResult
      try {
        sendResult = await ctx.im.sendText(conversation.id, 'Hook 联调测试：已收到消息，回复链路正常。', {})
        await new Promise((resolve) => setTimeout(resolve, 1800))
      } finally {
        for (const subscription of subscriptions) subscription?.unsubscribe?.()
      }

      return {
        success: sendResult?.success !== false,
        statusCode: sendResult?.statusCode,
        eventCount: events.length,
        events,
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
