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
      let lightRuntime = null
      try { lightRuntime = await window.__get_light_runtime?.() } catch (_) {}
      const rootEntries = [
        ['lightRuntime', lightRuntime],
        ['lightRuntime.default', lightRuntime?.default],
        ['monaStore', window.__mona_store__],
        ['monaGlobalStore', window.__monaGlobalStore],
        ['lightApp', window.__lightApp],
        ['goodsModule', window['@ecom-mcenter/ffa-goods:1.0.1.8292']],
        ['microApp', window.__microApp],
        ['garfishApp', window.Garfish?.activeApps?.[0]],
      ]
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!/(goods|product|sku|store|ref|model|query|list)/i.test(key)) continue
        let value
        try { value = window[key] } catch (_) { continue }
        if (value && ['object', 'function'].includes(typeof value)) rootEntries.push(['window.' + key, value])
      }

      const roots = rootEntries.map(([path, value]) => ({ path, value, depth: 0 }))
      const seen = new Set()
      const queue = [...roots]
      const matches = []
      const shapes = []
      const skip = /^(window|globalThis|self|parent|top|frames|document|ownerDocument|parentNode|children|childNodes|prototype|__proto__)$/
      while (queue.length && seen.size < 100000 && matches.length < 100) {
        const item = queue.shift()
        const value = item.value
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        let keys = []
        try { keys = Object.getOwnPropertyNames(value).slice(0, 2000) } catch (_) { continue }
        if (item.depth <= 1) shapes.push({ path: item.path, keys: keys.slice(0, 300) })
        const keySet = new Set(keys)
        if (['product_id', 'productId', 'goods_id', 'goodsId'].some((key) => keySet.has(key))) {
          const sample = {}
          for (const key of keys.slice(0, 120)) {
            let child
            try { child = value[key] } catch (_) { continue }
            if (child == null || ['string', 'number', 'boolean'].includes(typeof child)) sample[key] = child
          }
          matches.push({ path: item.path, sample })
        }
        if (item.depth >= 10) continue
        for (const key of keys) {
          if (skip.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (child && ['object', 'function'].includes(typeof child)) queue.push({ path: item.path + '.' + key, value: child, depth: item.depth + 1 })
        }
      }
      return { visited: seen.size, shapes, matches }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
