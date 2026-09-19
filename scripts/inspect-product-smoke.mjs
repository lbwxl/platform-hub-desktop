const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /fxg\.jinritemai\.com\/ffa\/g\/list/i.test(item.url))
if (!target) throw new Error('未找到抖店商品管理页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  const timer = setTimeout(() => reject(new Error('商品运行时只读诊断超时')), 20_000)
  socket.addEventListener('message', function listener(event) {
    const message = JSON.parse(event.data)
    if (message.id !== id) return
    clearTimeout(timer)
    socket.removeEventListener('message', listener)
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
    else resolve(message.result?.result?.value)
  })
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sizeOf = (value) => {
          if (!value) return 0
          if (Array.isArray(value)) return value.length
          if (Number.isFinite(value.size)) return Number(value.size)
          try { return Object.keys(value).length } catch (_) { return 0 }
        }
        const relevantStorageKeys = Object.keys(localStorage)
          .filter((key) => /(goods|product|swr|cache)/i.test(key))
          .slice(0, 80)
        const storage = relevantStorageKeys.map((key) => {
          const raw = localStorage.getItem(key) || ''
          let value = null
          try { value = JSON.parse(raw) } catch (_) {}
          return { key, length: raw.length, entryCount: sizeOf(value) }
        })
        let swr = {}
        try { swr = JSON.parse(localStorage.getItem('GOODS_SWR_CACHE_V1') || '{}') } catch (_) {}
        const swrEntries = Object.entries(swr).slice(0, 120).map(([key, entry]) => {
          const value = entry?.__value__?.data || entry?.value?.data || entry?.data || entry
          const sample = Array.isArray(value) ? value[0] : value?.items?.[0] || value?.list?.[0] || value?.records?.[0]
          return {
            productListKey: /product.*(?:list|search)|(?:list|search).*product/i.test(key),
            goodsListKey: /goods.*(?:list|search)|(?:list|search).*goods/i.test(key),
            valueKeys: value && typeof value === 'object' ? Object.keys(value).slice(0, 80) : [],
            directLength: sizeOf(value),
            listLength: sizeOf(value?.list),
            itemsLength: sizeOf(value?.items),
            recordsLength: sizeOf(value?.records),
            dataLength: sizeOf(value?.data),
            sampleKeys: sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 120) : [],
          }
        })
        const api = window.__platformHub
        return {
          url: location.origin + location.pathname,
          hookVersion: api?.__version || '',
          auth: await api?.getAuthState?.(),
          diagnose: await api?.diagnose?.(),
          storage,
          swrEntryCount: Object.keys(swr).length,
          swrEntries,
          knownGlobals: Object.getOwnPropertyNames(window)
            .filter((name) => /(goods|product|swr|store|garfish|light_runtime)/i.test(name))
            .slice(0, 120),
        }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
