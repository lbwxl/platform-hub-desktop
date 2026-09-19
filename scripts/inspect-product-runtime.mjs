const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /fxg\.jinritemai\.com\/ffa\/g\/list/i.test(item.url))
if (!target) throw new Error('未找到抖店商品管理 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

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

socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const standard = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)))
      const globals = []
      const queue = []
      for (const key of Object.getOwnPropertyNames(window)) {
        if (standard.has(key)) continue
        let value
        try { value = window[key] } catch (_) { continue }
        if (!value || !['object', 'function'].includes(typeof value)) continue
        let names = []
        try { names = Object.getOwnPropertyNames(value).slice(0, 500) } catch (_) {}
        globals.push({ key, type: typeof value, members: names.filter((name) => /(goods|product|list|detail|query|search|fetch|request|shop|sku|page|api|store)/i.test(name)).slice(0, 120) })
        if (/(goods|product|list|detail|query|search|fetch|request|shop|sku|api|store|runtime|app|garfish|redux|webpack|modern)/i.test(key)) {
          queue.push({ path: 'window.' + key, value, depth: 0 })
        }
      }

      const seen = new Set()
      const found = []
      const interesting = /(goods|product|list|detail|query|search|fetch|request|shop|sku|page)/i
      while (queue.length && seen.size < 20000 && found.length < 500) {
        const item = queue.shift()
        const value = item.value
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        let names = []
        try { names = Object.getOwnPropertyNames(value).slice(0, 1000) } catch (_) {}
        const methods = []
        for (const name of names) {
          let child
          try { child = value[name] } catch (_) { continue }
          if (typeof child === 'function' && interesting.test(name)) methods.push({ name, arity: child.length, source: String(child).slice(0, 500) })
          if (item.depth < 7 && child && ['object', 'function'].includes(typeof child) && !/^(window|document|globalThis|parent|top|frames|prototype|__proto__)$/.test(name)) {
            queue.push({ path: item.path + '.' + name, value: child, depth: item.depth + 1 })
          }
        }
        if (methods.length) found.push({ path: item.path, methods })
      }
      return { globals: globals.filter((item) => item.members.length || /(goods|product|store|runtime|app|garfish|webpack)/i.test(item.key)), visited: seen.size, found }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
