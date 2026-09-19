const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /jinritemai\.com/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 10_000)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)); else resolve(message.result?.result?.value)
  })
})
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
  const ctx = window.__mona_pigeon_event?.globalStore?.data?.initContextData
  const roots = { ctx, im: ctx?.im, pigeonIM: ctx?.im?.pigeonIM, coreIM: ctx?.im?.pigeonIM?._coreIM }
  const seen = new Set(); const queue = Object.entries(roots).map(([path, value]) => ({ path, value, depth: 0 })); const output = []
  while (queue.length && seen.size < 1000) {
    const item = queue.shift(); const value = item.value
    if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
    seen.add(value)
    let names = []
    try { names = Object.getOwnPropertyNames(value) } catch (_) {}
    const functions = []; const objects = []
    for (const name of names) {
      let child
      try { child = value[name] } catch (_) { continue }
      if (typeof child === 'function') functions.push({ name, arity: child.length, source: /(send|message|create|build|conversation|upload|text)/i.test(name) ? String(child).slice(0, 600) : undefined })
      else if (child && typeof child === 'object') objects.push(name)
      if (item.depth < 3 && child && typeof child === 'object' && !/(window|document|globalContext|options|eventBus|logger)/i.test(name)) queue.push({ path: item.path + '.' + name, value: child, depth: item.depth + 1 })
    }
    if (functions.length) output.push({ path: item.path, functions, objects })
  }
  return output
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
