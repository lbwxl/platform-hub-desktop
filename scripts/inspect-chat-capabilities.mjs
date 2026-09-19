const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 IM CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 20_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  const roots = [
    ['ctx', window.__mona_pigeon_event?.globalStore?.data?.initContextData],
    ['store', window.ss?._frontStore],
    ['monaStore', window.__mona_store__],
    ['pigeon', window.mona_remote_pigeon],
    ['loader', window.__pigeonPluginLoader],
    ['kora', window.Kora],
  ]
  const pattern = /(order|after|sale|refund|transfer|assign|staff|service|send|file|image|upload|conversation|message)/i
  const output = []
  const seen = new Set()
  const queue = roots.map(([path, value]) => ({ path, value, depth: 0 }))
  while (queue.length && seen.size < 8000) {
    const item = queue.shift(); const value = item.value
    if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
    seen.add(value)
    let names = []
    try { names = Object.getOwnPropertyNames(value).slice(0, 1200) } catch (_) {}
    const methods = []
    for (const name of names) {
      let child
      try { child = value[name] } catch (_) { continue }
      if (typeof child === 'function' && pattern.test(name)) methods.push({ name, arity: child.length, source: String(child).slice(0, 600) })
      if (item.depth < 5 && child && ['object', 'function'].includes(typeof child) && !/^(window|document|globalThis|parent|top|frames|prototype|__proto__|\$treenode)$/.test(name)) queue.push({ path: item.path + '.' + name, value: child, depth: item.depth + 1 })
    }
    if (methods.length) output.push({ path: item.path, methods })
  }
  return output
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
