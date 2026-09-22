const listenMs = Number(process.argv[2] || 30 * 60_000)
const cdpPort = process.env.PLATFORM_HUB_CDP_PORT || '9565'
const pattern = process.env.PLATFORM_HUB_CDP_TARGET_PATTERN || 'fxg.jinritemai.com/ffa/arrival-pages/home'
let target
const waitUntil = Date.now() + listenMs
while (!target && Date.now() < waitUntil) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json())
  target = targets.find((item) => item.type === 'page' && item.url.includes(pattern))
  if (!target) await new Promise((resolve) => setTimeout(resolve, 2_000))
}
if (!target) throw new Error(`未找到 CDP 页面: ${pattern}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
function command(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message || method))
      else resolve(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

const safe = `(() => {
  const blocked = /(token|cookie|header|phone|mobile|address|security|password|credential|secret|avatar|image|url)/i
  const relevant = /(order|trade|status|state|buyer|user|shop|sku|product|goods|item|amount|price|count|quantity|time|version|refresh|pay|create|update|notice|notify|event|socket|message)/i
  const project = (value, depth = 0, seen = new Set()) => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return undefined
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => project(item, depth + 1, seen)).filter((item) => item !== undefined)
    const output = {}
    let keys = []
    try { keys = Object.getOwnPropertyNames(value).slice(0, 200) } catch (_) { return output }
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
  const roots = Object.getOwnPropertyNames(window).filter((key) => relevant.test(key)).slice(0, 150)
  const rootInventory = roots.map((key) => {
    let value
    try { value = window[key] } catch (_) { return { key, error: true } }
    let keys = []
    try { keys = value && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyNames(value).slice(0, 150) : [] } catch (_) {}
    return { key, keys }
  })
  const store = window.ss?._frontStore
  const mona = window.__mona_pigeon_event
  const globalStore = mona?.globalStore?.data
  const eventNames = {
    app: Object.keys(mona?._eventMapByApp || {}).filter((key) => relevant.test(key)).sort(),
    plugin: Object.keys(mona?._eventMapByPlugin || {}).filter((key) => relevant.test(key)).sort(),
  }
  return {
    url: location.href,
    title: document.title,
    roots: rootInventory,
    eventNames,
    storeKeys: Object.keys(store || {}).filter((key) => relevant.test(key)).slice(0, 200),
    globalStoreKeys: Object.keys(globalStore || {}).filter((key) => relevant.test(key)).slice(0, 200),
    state: project(store?.state || store?.uiState || globalStore),
  }
})()`

const evaluate = async (expression) => (await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
console.log(JSON.stringify({ type: 'runtime.inventory', timestamp: Date.now(), value: await evaluate(safe) }))
await command('Network.enable', { maxResourceBufferSize: 2_000_000, maxTotalBufferSize: 20_000_000 })
await command('Runtime.enable')
console.log(JSON.stringify({ type: 'capture.ready', timestamp: Date.now(), target: { title: target.title, url: target.url }, pattern }))

const requests = new Map()
const relevantEndpoint = /(order|trade|payment|pay|refund|after.?sale|notify|notice|message|event|socket|subscribe|homepage|mshop|workstation)/i
const blocked = /(token|cookie|header|phone|mobile|address|security|password|credential|secret|avatar|image)/i
const sanitize = (value, depth = 0) => {
  if (depth > 6) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, child] of Object.entries(value).slice(0, 180)) {
    if (blocked.test(key)) continue
    if (child && typeof child === 'object') output[key] = sanitize(child, depth + 1)
    else if (typeof child === 'string' && child.length > 500) output[key] = child.slice(0, 500)
    else output[key] = child
  }
  return output
}
socket.addEventListener('message', async (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Network.webSocketCreated') {
    console.log(JSON.stringify({ type: 'websocket.created', timestamp: Date.now(), endpoint: message.params.url.split('?')[0] }))
  } else if (message.method === 'Network.webSocketFrameReceived') {
    const payload = message.params.response.payloadData
    if (relevantEndpoint.test(payload)) console.log(JSON.stringify({ type: 'websocket.frame', timestamp: Date.now(), payload: payload.slice(0, 20_000) }))
  } else if (message.method === 'Network.eventSourceMessageReceived') {
    if (relevantEndpoint.test(message.params.data)) console.log(JSON.stringify({ type: 'sse', timestamp: Date.now(), eventName: message.params.eventName, data: message.params.data.slice(0, 20_000) }))
  } else if (message.method === 'Network.responseReceived') {
    const url = message.params.response.url
    if (relevantEndpoint.test(url)) {
      requests.set(message.params.requestId, url)
      console.log(JSON.stringify({ type: 'response', timestamp: Date.now(), requestId: message.params.requestId, url: url.split('?')[0], status: message.params.response.status }))
    }
  } else if (message.method === 'Network.loadingFinished' && requests.has(message.params.requestId)) {
    const url = requests.get(message.params.requestId)
    requests.delete(message.params.requestId)
    try {
      const body = await command('Network.getResponseBody', { requestId: message.params.requestId })
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
      if (text.length <= 2_000_000) {
        let data = text
        try { data = sanitize(JSON.parse(text)) } catch (_) {}
        console.log(JSON.stringify({ type: 'response.body', timestamp: Date.now(), url: url.split('?')[0], data }))
      }
    } catch (error) {
      console.log(JSON.stringify({ type: 'diagnostic.error', timestamp: Date.now(), method: 'Network.getResponseBody', message: String(error.message || error) }))
    }
  }
})

const started = Date.now()
while (Date.now() - started < listenMs) {
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  try {
    const value = await evaluate(`(() => ({ timestamp: Date.now(), state: (${safe}).state, eventNames: (${safe}).eventNames }))()`)
    console.log(JSON.stringify({ type: 'runtime.snapshot', timestamp: Date.now(), value }))
  } catch (error) {
    console.log(JSON.stringify({ type: 'diagnostic.error', timestamp: Date.now(), method: 'Runtime.evaluate', message: String(error.message || error) }))
  }
}
socket.close()
