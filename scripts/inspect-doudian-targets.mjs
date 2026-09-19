const port = process.env.PLATFORM_HUB_CDP_PORT || '9333'
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
const target = targets.find((item) => /jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const response = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timeout)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  returnByValue: true,
  expression: `(() => {
    const roots = {
      ss: window.ss,
      frontStore: window.ss?._frontStore,
      monaStore: window.__mona_store__,
      monaEvent: window.__mona_pigeon_event,
      monaGlobalStore: window.__mona_pigeon_event?.globalStore,
      workbenchEvent: window.__WORKBENCH_EVENT_SDK_IN_WINDOW__,
      pluginLoader: window.__pigeonPluginLoader,
      pigeonRemote: window.mona_remote_pigeon,
      kora: window.Kora,
    }
    const seen = new Set()
    const output = []
    const queue = Object.entries(roots).map(([path, value]) => ({ path, value, depth: 0 }))
    while (queue.length && output.length < 800) {
      const { path, value, depth } = queue.shift()
      if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
      seen.add(value)
      let own = []
      let proto = []
      try { own = Object.getOwnPropertyNames(value).slice(0, 400).map((key) => { let type = 'unknown'; try { type = typeof value[key] } catch (_) {}; return { key, type } }) } catch (_) {}
      try { const p = Object.getPrototypeOf(value); if (p) proto = Object.getOwnPropertyNames(p).filter((key) => key !== 'constructor').map((key) => { let type = 'unknown'; try { type = typeof value[key] } catch (_) {}; return { key, type } }) } catch (_) {}
      output.push({ path, own, proto })
      if (depth >= 5) continue
      for (const item of own) {
        if (item.type !== 'object' && item.type !== 'function') continue
        if (!/(store|state|chat|message|session|conversation|user|goods|product|order|api|client|service|manager|event|sdk|plugin|remote|current|dispatch|action|model|data)/i.test(item.key)) continue
        try { queue.push({ path: path + '.' + item.key, value: value[item.key], depth: depth + 1 }) } catch (_) {}
      }
    }
    return output
  })()`
} }))
console.log(JSON.stringify(await response, null, 2))
socket.close()
