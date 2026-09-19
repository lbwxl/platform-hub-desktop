const listenMs = Number(process.argv[2] || 5 * 60_000)
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
function evaluate(expression) {
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
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression } }))
  })
}

const installed = await evaluate(`(() => {
  window.__doudianOrderProbe?.dispose?.()
  const store = window.ss?._frontStore
  const mona = window.__mona_pigeon_event
  const context = mona?.globalStore?.data?.initContextData
  const events = []
  const subscriptions = []
  const fingerprints = new Map()
  const blocked = /(token|cookie|header|phone|mobile|address|security|password|credential|secret|avatar|image|url)/i
  const relevant = /(order|trade|status|state|buyer|user|conversation|session|sku|product|goods|item|amount|price|count|quantity|time|version|refresh|pay|create|update)/i
  const scalar = (value) => value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined
  const project = (value, depth = 0, seen = new Set()) => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return undefined
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 10).map((item) => project(item, depth + 1, seen)).filter((item) => item !== undefined)
    const output = {}
    let keys = []
    try { keys = Object.getOwnPropertyNames(value).slice(0, 180) } catch (_) { return output }
    for (const key of keys) {
      if (blocked.test(key) || !relevant.test(key)) continue
      let child
      try { child = value[key] } catch (_) { continue }
      if (typeof child === 'function') continue
      const nested = project(child, depth + 1, seen)
      if (nested !== undefined) output[key] = nested
    }
    return output
  }
  const push = (source, payload) => {
    events.push({ source, payload, timestamp: Date.now() })
    if (events.length > 300) events.splice(0, events.length - 300)
  }
  const summarizeMessage = (raw) => {
    const value = raw?.message || raw?.data || raw?.payload || raw
    if (!value || typeof value !== 'object') return null
    const ext = value.ext || {}
    let cardHeader = ext.card_header
    if (typeof cardHeader === 'string') { try { cardHeader = JSON.parse(cardHeader) } catch (_) {} }
    return {
      id: String(value.serverId || value.messageId || value.clientId || value.id || ''),
      sessionId: String(value.conversationId || value.originConversationId || value.securityConversationId || ''),
      senderId: String(value.sender || value.senderId || value.originSender || value.securitySender || value.from || ''),
      timestamp: Number(value.createTime || value.createdAt || value.timestamp || 0),
      type: String(ext.type || value.type || value.messageType || ''),
      cardSource: String(cardHeader?.cardSourceScene || ''),
      orderId: String(ext.order_id || ext.shop_order_id || ext.sku_order_id || ''),
      extKeys: Object.keys(ext).filter((key) => !blocked.test(key)).slice(0, 100),
    }
  }
  const visitMessages = (input) => {
    const pending = [input]
    const seen = new Set()
    const output = []
    while (pending.length && seen.size < 200) {
      const item = pending.shift()
      if (!item || typeof item !== 'object' || seen.has(item)) continue
      seen.add(item)
      const message = summarizeMessage(item)
      if (message?.id || message?.sessionId) output.push(message)
      if (Array.isArray(item)) pending.push(...item)
      for (const key of ['message', 'data', 'payload', 'messages', 'items', 'list']) {
        try {
          const child = item[key]
          if (Array.isArray(child)) pending.push(...child)
          else if (child && typeof child === 'object') pending.push(child)
        } catch (_) {}
      }
    }
    return output
  }
  const im = context?.im
  for (const [name, stream] of [['_message$', im?._message$], ['_messageUpsert$', im?._messageUpsert$], ['_batchUpsert$', im?._batchUpsert$]]) {
    if (typeof stream?.subscribe !== 'function') continue
    try { subscriptions.push(stream.subscribe((value) => push('im.' + name, visitMessages(value)))) } catch (error) { push('error', { source: name, error: String(error?.message || error) }) }
  }
  const services = []
  for (const key of ['MessagesModelSymbol', 'PCUIModelSymbol']) {
    try {
      const service = context?.zContainer?.get?.(context[key])
      if (service?.state$?.subscribe) {
        services.push(key)
        subscriptions.push(service.state$.subscribe((value) => {
          const projected = project(value)
          const text = JSON.stringify(projected)
          if (text && text !== '{}' && fingerprints.get('state:' + key) !== text) {
            fingerprints.set('state:' + key, text)
            push('state.' + key, projected)
          }
        }))
      }
    } catch (error) { push('error', { source: key, error: String(error?.message || error) }) }
  }
  const snapshot = () => {
    const sources = {
      workstation: store?.uiState?.workstation,
      history: store?.historyConversationData,
      taskOrder: store?.taskOrder,
      orderInvitation: store?.orderInvitation,
      currentBuyer: store?.buyerMap?.currentTalkingBuyer,
    }
    for (const [name, value] of Object.entries(sources)) {
      const projected = project(value)
      const text = JSON.stringify(projected)
      if (!fingerprints.has('store:' + name)) fingerprints.set('store:' + name, text)
      else if (fingerprints.get('store:' + name) !== text) {
        fingerprints.set('store:' + name, text)
        push('store.' + name, projected)
      }
    }
    const appNames = Object.keys(mona?._eventMapByApp || {}).filter((name) => /(order|trade|pay|refresh)/i.test(name)).sort()
    const pluginNames = Object.keys(mona?._eventMapByPlugin || {}).filter((name) => /(order|trade|pay|refresh)/i.test(name)).sort()
    const eventText = JSON.stringify({ appNames, pluginNames })
    if (!fingerprints.has('eventNames')) fingerprints.set('eventNames', eventText)
    else if (fingerprints.get('eventNames') !== eventText) {
      fingerprints.set('eventNames', eventText)
      push('event.names', { appNames, pluginNames })
    }
  }
  snapshot()
  const timer = setInterval(snapshot, 350)
  window.__doudianOrderProbe = {
    drain: () => events.splice(0, events.length),
    status: () => ({ installed: true, subscriptions: subscriptions.length, services, startedAt: Date.now() }),
    dispose: () => {
      clearInterval(timer)
      for (const item of subscriptions.splice(0)) { try { if (typeof item === 'function') item(); else item?.unsubscribe?.() } catch (_) {} }
      events.length = 0
    },
  }
  return window.__doudianOrderProbe.status()
})()`)

console.log(JSON.stringify({ listening: true, listenMs, installed }))
const started = Date.now()
while (Date.now() - started < listenMs) {
  await new Promise((resolve) => setTimeout(resolve, 800))
  const events = await evaluate(`window.__doudianOrderProbe?.drain?.() || []`)
  for (const event of events) console.log(JSON.stringify(event))
}
await evaluate(`window.__doudianOrderProbe?.dispose?.(); delete window.__doudianOrderProbe`)
socket.close()
