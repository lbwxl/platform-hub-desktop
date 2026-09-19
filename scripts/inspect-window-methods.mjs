const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.jinritemai\.com\/pc_seller_v2\/main\/workspace/i.test(item.url))
if (!target) throw new Error('未找到抖店 CDP 页面')
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
const searchPattern = process.argv[2] || '(send|message|conversation|product|goods|order|upload|transfer|reply|listen|subscribe|session|chat|talker|buyer|input)'
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression: `(async () => {
  let lightRuntime = null
  try { lightRuntime = await window.__get_light_runtime?.() } catch (_) {}
  const roots = {
    ss: window.ss,
    pigeonRemote: window.mona_remote_pigeon,
    pluginLoader: window.__pigeonPluginLoader,
    monaEvent: window.__mona_pigeon_event,
    workbenchEvent: window.__WORKBENCH_EVENT_SDK_IN_WINDOW__,
    lightRuntime,
  }
  const seen = new Set()
  const queue = Object.entries(roots).map(([path, value]) => ({ path, value, depth: 0 }))
  const found = []
  const interesting = new RegExp(${JSON.stringify(searchPattern)}, 'i')
  while (queue.length && seen.size < 15000 && found.length < 800) {
    const item = queue.shift(); const value = item.value
    if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
    seen.add(value)
    let names = []
    try { names = Object.getOwnPropertyNames(value).slice(0, 1000) } catch (_) {}
    const methods = []
    for (const key of names) {
      let child
      try { child = value[key] } catch (_) { continue }
      if (typeof child === 'function' && interesting.test(key)) methods.push({ name: key, arity: child.length })
      if (item.depth < 7 && child && ['object', 'function'].includes(typeof child) && key !== '$treenode' && !/^(__proto__|prototype|constructor|parent|root|globalThis|window|document)$/.test(key)) {
        queue.push({ path: item.path + '.' + key, value: child, depth: item.depth + 1 })
      }
    }
    if (methods.length) found.push({ path: item.path, methods })
  }
  return { lightRuntime: lightRuntime ? Object.getOwnPropertyNames(lightRuntime) : [], visited: seen.size, found }
})()` } }))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
