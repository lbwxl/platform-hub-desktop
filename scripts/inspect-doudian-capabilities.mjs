const port = process.env.PLATFORM_HUB_CDP_PORT || '9333'
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
const target = targets.find((item) => /jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.error) reject(new Error(message.error.message)); else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text + ': ' + (message.result.exceptionDetails.exception?.description || ''))); else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  const root = window.ss?._frontStore
  if (!root) return { error: 'frontStore unavailable' }
  const seen = new Set()
  const queue = [{ value: root, path: 'ss._frontStore', depth: 0 }]
  const capabilities = []
  while (queue.length && seen.size < 2500) {
    const item = queue.shift(); const value = item.value
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    let keys = []
    try { keys = Object.getOwnPropertyNames(value).slice(0, 500) } catch (_) {}
    const methods = keys.filter((key) => {
      try { return typeof value[key] === 'function' && /(send|message|conversation|chat|session|goods|product|order|upload|transfer|user|talker|reply|current)/i.test(key) } catch (_) { return false }
    })
    if (methods.length) capabilities.push({ path: item.path, methods })
    if (item.depth >= 5) continue
    for (const key of keys) {
      if (key === '$treenode' || key === 'parent' || key === 'root') continue
      let child
      try { child = value[key] } catch (_) { continue }
      if (child && typeof child === 'object') queue.push({ value: child, path: item.path + '.' + key, depth: item.depth + 1 })
    }
  }
  const conversations = root.conversationsInfo
  const map = conversations?.conversationMap
  let values = []
  try { values = map instanceof Map ? [...map.values()] : Array.isArray(map) ? map : Object.values(map || {}) } catch (_) {}
  const testConversation = values.find((item) => String(JSON.stringify(item) || '').includes('.ai'))
  const safeConversation = testConversation ? JSON.parse(JSON.stringify(testConversation)) : null
  return {
    authenticated: Boolean(root.shopInfo || window.__mona_store__?.shopId),
    shopInfoKeys: Object.keys(root.shopInfo || {}),
    selfInfoKeys: Object.keys(root.selfInfo || {}),
    conversationCount: values.length,
    testConversation: safeConversation,
    capabilities: capabilities.slice(0, 200),
  }
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
