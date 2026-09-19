const targetId = process.argv[2]
if (!targetId) throw new Error('请提供快手会话 targetId')

const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const answer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('快手发送上下文诊断超时')), 30_000)
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

      const targetId = ${JSON.stringify(targetId)}
      const blockedKey = /(token|cookie|header|phone|address|authorization|credential|secret|security|password)/i
      const scalar = (value) => {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
        if (typeof value === 'bigint') return String(value)
        try { return { type: value.constructor?.name || typeof value, text: String(value) } } catch (_) { return { type: typeof value } }
      }
      const scalars = (value, limit = 160) => {
        if (!value || typeof value !== 'object') return null
        const output = {}
        for (const key of Object.getOwnPropertyNames(value).slice(0, limit)) {
          if (blockedKey.test(key) || /(content|text|title|body|avatar)/i.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (child == null || ['string', 'number', 'boolean', 'bigint'].includes(typeof child)) output[key] = scalar(child)
        }
        return output
      }
      const structure = (value) => {
        if (!value || typeof value !== 'object') return scalar(value)
        const output = {}
        for (const key of Object.getOwnPropertyNames(value).slice(0, 120)) {
          if (blockedKey.test(key) || /(content|text|title|body|avatar)/i.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (typeof child === 'function') continue
          if (child == null || ['string', 'number', 'boolean', 'bigint'].includes(typeof child)) output[key] = scalar(child)
          else if (ArrayBuffer.isView(child) || child instanceof ArrayBuffer) output[key] = { type: child.constructor?.name || 'ArrayBuffer', byteLength: child.byteLength }
          else if (Array.isArray(child)) output[key] = { type: 'array', length: child.length }
          else output[key] = { type: child.constructor?.name || 'object', keys: Object.getOwnPropertyNames(child).filter((name) => !blockedKey.test(name)).slice(0, 50) }
        }
        return output
      }
      const businessFields = (value) => {
        if (!value || typeof value !== 'object') return null
        const output = {}
        for (const key of ['realFromRole', 'sourcePage', 'device', 'senderUserId', 'assistantId', 'newSession', 'isAiGenerateMessage', 'isSubsidiaryReply']) {
          let child
          try { child = value[key] } catch (_) { continue }
          if (child !== undefined) output[key] = scalar(child)
        }
        return output
      }
      const values = (value) => {
        if (!value) return []
        if (Array.isArray(value)) return value
        try { if (typeof value.values === 'function') return Array.from(value.values()) } catch (_) {}
        try { return Object.values(value) } catch (_) { return [] }
      }
      const summarizeMessage = (item) => {
        const message = item?.kMsg || item
        const raw = message?.rawMsg || item?.rawMsg
        let pb = null
        try {
          const value = message?.toPbMessage?.()
          if (value) pb = {
            scalar: scalars(value),
            keys: Object.keys(value).filter((key) => !blockedKey.test(key) && !/(content|text|title|body)/i.test(key)),
            chatTarget: structure(value.chatTarget),
            contentBytes: value.content?.byteLength ?? value.content?.length,
            extraBytes: value.extra?.byteLength ?? value.extra?.length,
          }
        } catch (error) { pb = { error: String(error?.message || error) } }
        return {
          wrapper: scalars(item),
          message: scalars(message),
          raw: structure(raw),
          extraInfo: structure(message?.eExtra),
          bizExtras: structure(message?.eExtra?.bizExtras),
          merchantExtra: structure(message?.eExtra?.bizExtras?.MERCHANT),
          merchantBusinessFields: businessFields(message?.eExtra?.bizExtras?.MERCHANT),
          logParams: structure(message?.eExtra?.logParams),
          pageRefers: structure(message?.eExtra?.pageRefers),
          pb,
        }
      }

      const messages = values(sdk.currentSessionMessageListStore?.messages)
      const outgoing = messages.filter((item) => {
        const raw = item?.kMsg?.rawMsg || item?.rawMsg
        return String(raw?.sessionTargetId || raw?.strTargetId || '') === targetId
          && String(raw?.fromUserId || '') === String(sdk.esImSdk?.uid || '')
      })
      const success = outgoing.slice().reverse().find((item) => Number((item?.kMsg?.rawMsg || item?.rawMsg)?.state) === 4)
      const failed = outgoing.slice().reverse().find((item) => Number((item?.kMsg?.rawMsg || item?.rawMsg)?.state) === 2)

      const functionInfo = (owner, key, path) => {
        let fn
        try { fn = owner[key] } catch (_) { return null }
        if (typeof fn !== 'function') return null
        let source = ''
        try { source = String(fn).slice(0, 20_000) } catch (_) {}
        return { path: path + '.' + key, arity: fn.length, source }
      }
      const senderMethods = []
      const seenMethods = new Set()
      for (let owner = sdk.messageSender, depth = 0; owner && depth < 5; owner = Object.getPrototypeOf(owner), depth += 1) {
        for (const key of Object.getOwnPropertyNames(owner).slice(0, 300)) {
          if (key === 'constructor' || seenMethods.has(key) || !/(send|create|build|message|extra|target)/i.test(key)) continue
          seenMethods.add(key)
          const info = functionInfo(sdk.messageSender, key, 'sdk.messageSender')
          if (info) senderMethods.push(info)
        }
      }

      const roots = [{ value: sdk, path: 'sdk', depth: 0 }]
      const graphSeen = new Set()
      const businessMethods = []
      const objectSummaries = []
      while (roots.length && graphSeen.size < 900) {
        const current = roots.shift()
        const value = current.value
        if (!value || !['object', 'function'].includes(typeof value) || graphSeen.has(value)) continue
        graphSeen.add(value)
        let keys = []
        try { keys = Object.getOwnPropertyNames(value).slice(0, 160) } catch (_) { continue }
        if (/(send|input|reply|message|chat|session|store|model|service)/i.test(current.path)) {
          objectSummaries.push({ path: current.path, keys: keys.filter((key) => !blockedKey.test(key)).slice(0, 100) })
        }
        for (const key of keys) {
          if (blockedKey.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (typeof child === 'function' && /(send|reply|input|message)/i.test(key)) {
            let source = ''
            try { source = String(child).slice(0, 12_000) } catch (_) {}
            if (/sendTextMsg|messageSender|sendMessage|sendMsg|sendReply/i.test(source) || /^(send|reply)/i.test(key)) {
              businessMethods.push({ path: current.path + '.' + key, arity: child.length, source })
            }
          }
          if (current.depth < 4 && child && ['object', 'function'].includes(typeof child)
            && /(send|input|reply|message|chat|session|store|model|service|sender|current|provider|sdk)/i.test(key)) {
            roots.push({ value: child, path: current.path + '.' + key, depth: current.depth + 1 })
          }
        }
      }

      const eventSources = []
      for (const eventName of ['sendBox.input', 'system.enterKeyUpOrDownOrEnter', 'message:recall:reedit']) {
        const event = sdk?._events?.[eventName]
        const listeners = Array.isArray(event) ? event : [event]
        eventSources.push({
          eventName,
          listeners: listeners.filter(Boolean).map((listener) => {
            const fn = typeof listener === 'function' ? listener : listener?.fn
            const context = listener?.context
            let source = ''
            try { source = String(fn || listener).slice(0, 20_000) } catch (_) {}
            return {
              source,
              listenerKeys: structure(listener),
              contextKeys: structure(context),
              contextMethods: context ? Object.getOwnPropertyNames(context).filter((key) => {
                try { return typeof context[key] === 'function' && /(send|reply|message|enter)/i.test(key) } catch (_) { return false }
              }).map((key) => functionInfo(context, key, 'eventContext')).filter(Boolean) : [],
            }
          }),
        })
      }

      const sessions = sdk.sessionModel?.sessionAllModel?.allSessionMap
      const session = typeof sessions?.get === 'function' ? sessions.get(targetId) : sessions?.[targetId]
      return {
        sdkKeys: Object.getOwnPropertyNames(sdk).filter((key) => !blockedKey.test(key)),
        sender: structure(sdk.messageSender),
        senderMethods,
        sdkMethodSources: ['logSendMessage', 'getSourcePageCode'].map((key) => functionInfo(sdk, key, 'sdk')).filter(Boolean),
        storeState: structure(sdk.store?.state),
        loginUser: structure(sdk.store?.state?.loginUserInfo),
        session: structure(session),
        currentSession: structure(sdk.currentSessionMessageListStore?.session),
        successfulOutgoing: summarizeMessage(success),
        failedOutgoing: summarizeMessage(failed),
        objectSummaries: objectSummaries.slice(0, 160),
        businessMethods: businessMethods.slice(0, 100),
        eventSources,
      }
    })()`,
  },
}))

console.log(JSON.stringify(await answer, null, 2))
socket.close()
