const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手事件 API 诊断超时')), 30_000)
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
    expression: `(() => {
      let sdk = window.__chat_sdk
      try {
        for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk
      } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }

      const memberNames = (value) => {
        const result = new Set()
        for (let owner = value, depth = 0; owner && depth < 4; owner = Object.getPrototypeOf(owner), depth += 1) {
          try { Object.getOwnPropertyNames(owner).forEach((key) => result.add(key)) } catch (_) {}
        }
        return Array.from(result).filter((key) => /(event|listen|message|update|emit|dispatch|subscribe|watch|^on$|^off$)/i.test(key)).slice(0, 200)
      }
      const describe = (value) => {
        if (!value || !['object', 'function'].includes(typeof value)) return null
        return {
          constructor: String(value.constructor?.name || ''),
          members: memberNames(value).map((key) => {
            let type = 'unknown'
            let arity
            try { type = typeof value[key]; if (type === 'function') arity = value[key].length } catch (_) {}
            return { key, type, arity }
          }),
        }
      }
      const source = (value) => typeof value === 'function' ? String(value).slice(0, 10_000) : null
      const candidates = []
      for (const key of Object.getOwnPropertyNames(sdk).slice(0, 500)) {
        if (!/(event|listen|message|update|emit|bus|system)/i.test(key)) continue
        let value
        try { value = sdk[key] } catch (_) { continue }
        if (value && ['object', 'function'].includes(typeof value)) candidates.push({ key, value: describe(value) })
      }
      return {
        hookVersion: window.__platformHub?.__version,
        sdk: describe(sdk),
        esImSdk: describe(sdk.esImSdk),
        eventNames: {
          sdk: typeof sdk.eventNames === 'function' ? sdk.eventNames().map(String) : [],
          esImSdk: typeof sdk.esImSdk?.eventNames === 'function' ? sdk.esImSdk.eventNames().map(String) : [],
        },
        listeners: {
          newMessageFromBuyer: typeof sdk.listeners === 'function'
            ? sdk.listeners('system.session.newMessageFromBuyer').map((listener) => String(listener).slice(0, 10_000))
            : [],
          messagesUpdate: typeof sdk.esImSdk?.listeners === 'function'
            ? sdk.esImSdk.listeners('messagesUpdate').map((listener) => String(listener).slice(0, 10_000))
            : [],
        },
        sources: {
          listenEvent: source(sdk.listenEvent),
          removeEvent: source(sdk.removeEvent),
          sdkOn: source(sdk.on),
          sdkOff: source(sdk.off),
          esOn: source(sdk.esImSdk?.on),
          esOff: source(sdk.esImSdk?.off),
        },
        candidates,
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
