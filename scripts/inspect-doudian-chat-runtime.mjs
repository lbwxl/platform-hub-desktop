const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
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
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  function describe(value) {
    if (!value) return null
    const result = []
    let current = value
    for (let depth = 0; current && depth < 4; depth += 1) {
      let names = []
      try { names = Object.getOwnPropertyNames(current) } catch (_) {}
      result.push({ depth, members: names.map((key) => { let type = 'unknown'; try { type = typeof value[key] } catch (_) {}; return key + ':' + type }).slice(0, 400) })
      try { current = Object.getPrototypeOf(current) } catch (_) { current = null }
    }
    return result
  }
  const store = window.ss?._frontStore
  const conv = store?.conversationsInfo
  const sources = [conv?.unClosedConversations, conv?.closedConversations, conv?.normalCurrentConversations, conv?.platformMessageConversations].filter(Array.isArray)
  const all = sources.flat()
  const test = all.filter((item) => String(JSON.stringify(item) || '').includes('.ai')).map((item) => JSON.parse(JSON.stringify(item)))
  const liveTest = all.find((item) => String(item?.rawExt?.fusion_uname || '').toLowerCase() === '.ai')
  let testRuntime = null
  if (liveTest) {
    const room = store?.uiState?.chatRooms?.getChatRoom?.(liveTest.id)
    const messageSource = typeof conv?.messagesByConversationId?.get === 'function' ? conv.messagesByConversationId.get(liveTest.id) : conv?.messagesByConversationId?.[liveTest.id]
    const summarizeMessage = (item) => item ? {
      content: String(item?.content || item?.text || item?.ext?.cs_special_content || ''),
      type: String(item?.ext?.type || item?.type || ''),
      createTime: Number(item?.createTime || item?.timestamp || 0),
      senderRole: String(item?.ext?.sender_role || item?.ext?.['s:sender_biz_role'] || ''),
      isMine: Boolean(item?.isMine),
    } : null
    const sortedMessages = Array.from(messageSource?.sortedMessages || messageSource?.visibleMessages || [])
    testRuntime = {
      lastMessage: liveTest.lastMessage ? JSON.parse(JSON.stringify(liveTest.lastMessage)) : null,
      lastAnyMessage: liveTest.lastAnyMessage ? JSON.parse(JSON.stringify(liveTest.lastAnyMessage)) : null,
      latestBuyerMessage: summarizeMessage(messageSource?.latestBuyerMessage),
      recentMessages: sortedMessages.slice(-12).map(summarizeMessage),
      talker: store?.talkerMap?.getTalkerInfo?.(liveTest.buyerId) ? JSON.parse(JSON.stringify(store.talkerMap.getTalkerInfo(liveTest.buyerId))) : null,
      messageCount: messageSource?.length || messageSource?.size || 0,
      messageSourceShape: describe(messageSource),
      roomShape: describe(room),
      roomSnapshot: room ? JSON.parse(JSON.stringify(room)) : null,
    }
  }
  const koraInstances = window.Kora?.instances
  let kora = []
  try { kora = (koraInstances instanceof Map ? [...koraInstances.entries()] : Object.entries(koraInstances || {})).map(([key, value]) => ({ key, shape: describe(value) })) } catch (_) {}
  const event = window.__mona_pigeon_event
  const matches = []
  const seen = new Set()
  const queue = [
    { path: 'talkerMap', value: store?.talkerMap, depth: 0 },
    { path: 'buyerMap', value: store?.buyerMap, depth: 0 },
    { path: 'conversationsInfo', value: store?.conversationsInfo, depth: 0 },
  ]
  while (queue.length && seen.size < 5000 && matches.length < 20) {
    const item = queue.shift(); const value = item.value
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    let keys = []
    try { keys = Object.keys(value).slice(0, 1000) } catch (_) {}
    let matched = false
    for (const key of keys) {
      let child
      try { child = value[key] } catch (_) { continue }
      if (typeof child === 'string' && child.toLowerCase().includes('.ai')) matched = true
      if (item.depth < 6 && child && typeof child === 'object') queue.push({ path: item.path + '.' + key, value: child, depth: item.depth + 1 })
    }
    if (matched) {
      let snapshot = null
      try { snapshot = JSON.parse(JSON.stringify(value)) } catch (_) {}
      matches.push({ path: item.path, snapshot })
    }
  }
  return {
    ssInstance: describe(window.ss?.instance),
    kora,
    appEvents: Object.keys(event?._eventMapByApp || {}),
    pluginEvents: Object.keys(event?._eventMapByPlugin || {}),
    pluginListeners: Object.keys(event?._pluginListenerMap || {}),
    scopeNames: Object.keys(event?._scopeMap || {}),
    conversationItemShape: describe(all[0]),
    testConversations: test,
    testRuntime,
    chatRooms: describe(store?.uiState?.chatRooms),
    currentTalkingBuyer: store?.buyerMap?.currentTalkingBuyer ? JSON.parse(JSON.stringify(store.buyerMap.currentTalkingBuyer)) : null,
    testUserMatches: matches,
  }
})()` } }))
const result = await answer
console.log(JSON.stringify(process.argv.includes('--input') ? result?.testRuntime : result, null, 2))
socket.close()
