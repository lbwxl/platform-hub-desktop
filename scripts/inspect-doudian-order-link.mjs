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
  const timer = setTimeout(() => reject(new Error('抖店订单归属诊断超时')), 20_000)
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
        const store = window.ss?._frontStore
        const info = store?.conversationsInfo
        const sources = [info?.unClosedConversations, info?.closedConversations, info?.normalCurrentConversations, info?.platformMessageConversations].filter(Array.isArray)
        const conversations = sources.flat()
        const conversation = conversations.find((item) => String(item?.rawExt?.fusion_uname || '').toLowerCase() === '.ai' || String(item?.title || '').toLowerCase() === '.ai')
        if (!conversation) return { error: 'test-session-not-found' }
        const source = typeof info?.messagesByConversationId?.get === 'function' ? info.messagesByConversationId.get(conversation.id) : info?.messagesByConversationId?.[conversation.id]
        const messages = Array.from(source?.sortedMessages || source?.visibleMessages || [])
        const parse = (value) => { try { return value && typeof value === 'string' ? JSON.parse(value) : value } catch (_) { return null } }
        const orderMessages = messages.map((item) => {
          const ext = item?.ext || {}
          const point = parse(ext.point_info) || {}
          const staticData = parse(ext.static_data) || {}
          const card = parse(ext.card_header) || {}
          const orderId = String(ext.order_id || ext.shop_order_id || ext.sku_order_id || point.shop_order_id || point.order_id || point.sku_order_id || '')
          if (!orderId && !/order/i.test(String(card.cardSourceScene || card.card_source_scene || ext.type || ''))) return null
          return {
            messageId: String(item?.serverId || item?.messageId || item?.id || ''),
            conversationId: String(item?.conversationId || item?.conversation_id || conversation.id || ''),
            createTime: Number(item?.createTime || item?.timestamp || 0),
            orderId,
            status: String(ext.order_status || staticData.order_status || staticData.orderStatus || point.order_status || ''),
            productName: String(staticData.product_name || staticData.productName || point.product_name || ''),
            senderRole: String(ext.sender_role || ext['s:sender_biz_role'] || ''),
            senderId: String(item?.sender || item?.senderId || item?.fromUserId || ''),
            cardSourceScene: String(card.cardSourceScene || card.card_source_scene || ''),
          }
        }).filter(Boolean)
        return {
          conversation: {
            id: String(conversation.id || ''),
            buyerId: String(conversation.buyerId || conversation.currentTalkId || conversation.userId || ''),
            title: String(conversation.rawExt?.fusion_uname || conversation.title || ''),
          },
          orderMessages,
        }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
