const targetId = process.argv[2]
const concise = process.argv.includes('--concise')
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
  const timer = setTimeout(() => reject(new Error('快手发送 API 诊断超时')), 30_000)
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
      const concise = ${JSON.stringify(concise)}
      let sdk = window.__chat_sdk
      try {
        for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk
      } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }
      const targetId = ${JSON.stringify(targetId)}
      const sessions = sdk.sessionModel?.sessionAllModel?.allSessionMap
      const session = typeof sessions?.get === 'function' ? sessions.get(targetId) : sessions?.[targetId]
      const current = sdk.currentSessionMessageListStore?.session
      const schema = (value) => {
        if (!value || typeof value !== 'object') return null
        const output = []
        for (const key of Object.getOwnPropertyNames(value).slice(0, 200)) {
          let child
          try { child = value[key] } catch (_) { continue }
          const type = typeof child
          const item = { key, type }
          if (type === 'function') item.arity = child.length
          else if (child == null || type === 'boolean' || type === 'number') item.value = child
          else if (type === 'string' && /(id|type|status|role|target|source)/i.test(key)) item.value = child
          else if (type === 'object') item.childKeys = Object.getOwnPropertyNames(child).slice(0, 80)
          output.push(item)
        }
        return output
      }
      const methodSources = []
      const sender = sdk.messageSender
      const seen = new Set()
      for (let owner = sender, depth = 0; owner && depth < 5; owner = Object.getPrototypeOf(owner), depth += 1) {
        for (const key of Object.getOwnPropertyNames(owner || {}).slice(0, 300)) {
          if (key === 'constructor' || seen.has(key)) continue
          seen.add(key)
          let value
          try { value = sender[key] } catch (_) { continue }
          if (typeof value !== 'function') continue
          methodSources.push({ key, arity: value.length, source: String(value).slice(0, 15_000) })
        }
      }
      const collectSources = (value, pattern) => {
        const output = []
        const names = new Set()
        for (let owner = value, depth = 0; owner && depth < 6; owner = Object.getPrototypeOf(owner), depth += 1) {
          for (const key of Object.getOwnPropertyNames(owner || {}).slice(0, 500)) {
            if (key === 'constructor' || names.has(key) || !pattern.test(key)) continue
            names.add(key)
            let method
            try { method = value[key] } catch (_) { continue }
            if (typeof method === 'function') output.push({ key, arity: method.length, source: String(method).slice(0, 20_000) })
          }
        }
        return output
      }
      const rawSession = current?.rawSession || current?.cachedSession
      const variants = [
        { name: 'string', targetId },
        { name: 'number', targetId: Number(targetId) },
        { name: 'targetUid', targetId: rawSession?.targetUid },
        { name: 'sessionId', targetId: rawSession?.id },
        { name: 'withDefaults', targetId, defaults: { backupTips: '', receiptRequired: false, notCountUnread: false, notAutoCreateSession: false, needForward: false } },
      ]
      const builtVariants = []
      const scalar = (value) => {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
        try { return { type: value.constructor?.name || typeof value, text: String(value) } } catch (_) { return { type: typeof value } }
      }
      const rawMetadata = (raw) => {
        if (!raw || typeof raw !== 'object') return null
        const output = {}
        for (const key of Object.getOwnPropertyNames(raw).slice(0, 200)) {
          if (!/(app|target|sender|from|type|seq|id|source|status|subBiz|biz)/i.test(key) || /(content|text|title|body|extra)/i.test(key)) continue
          let value
          try { value = raw[key] } catch (_) { continue }
          if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value
          else if (typeof value === 'object' && typeof value.toString === 'function') output[key] = scalar(value)
        }
        return output
      }
      const scalarMetadata = (value) => {
        if (!value || typeof value !== 'object') return null
        const output = {}
        for (const key of Object.getOwnPropertyNames(value).slice(0, 250)) {
          if (/(content|text|title|body|token|cookie|header|phone|address)/i.test(key)) continue
          let child
          try { child = value[key] } catch (_) { continue }
          if (child == null || ['string', 'number', 'boolean'].includes(typeof child)) output[key] = child
        }
        return output
      }
      const extraKeys = (value) => {
        let parsed = value
        if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch (_) { return [] } }
        if (!parsed || typeof parsed !== 'object') return []
        return Object.keys(parsed).filter((key) => !/(token|cookie|header|phone|address)/i.test(key)).slice(0, 100)
      }
      const pbSummary = (message) => {
        if (typeof message?.toPbMessage !== 'function') return null
        try {
          const pb = message.toPbMessage()
          return {
            keys: Object.keys(pb || {}).filter((key) => !/(content|token|cookie|header|phone|address)/i.test(key)),
            scalarMetadata: scalarMetadata(pb),
            chatTarget: scalarMetadata(pb?.chatTarget),
            contentType: scalar(pb?.contentType),
            contentKind: pb?.content?.constructor?.name || typeof pb?.content,
          }
        } catch (error) { return { error: String(error?.message || error) } }
      }
      for (const variant of variants) {
        try {
          const message = await sender.sendTextMsg({ targetType: Number(session?.chatTargetType || rawSession?.chatTargetType || 0), targetId: variant.targetId, text: 'probe', extra: {}, ...(variant.defaults || {}) }, true)
          builtVariants.push({
            name: variant.name,
            input: scalar(variant.targetId),
            keys: Object.getOwnPropertyNames(message || {}).slice(0, 100),
            id: scalar(message?.id),
            targetId: scalar(message?.targetId),
            sessionTargetId: scalar(message?.sessionTargetId),
            rawTargetUid: scalar(message?.rawMsg?.targetUid),
            rawStrTargetId: scalar(message?.rawMsg?.strTargetId),
            rawChatTargetType: scalar(message?.rawMsg?.chatTargetType),
            rawMetadata: rawMetadata(message?.rawMsg),
            rawScalarMetadata: scalarMetadata(message?.rawMsg),
            extraKeys: extraKeys(message?.rawMsg?.extra),
            messageMethods: collectSources(message, /(beforeSend|toPbMessage|encodeContent|validate)/i),
            pb: pbSummary(message),
          })
        } catch (error) {
          builtVariants.push({ name: variant.name, error: String(error?.message || error) })
        }
      }
      const values = (value) => {
        if (!value) return []
        if (Array.isArray(value)) return value
        try { if (typeof value.values === 'function') return Array.from(value.values()) } catch (_) {}
        try { return Object.values(value) } catch (_) { return [] }
      }
      const cachedMetadata = values(sdk.currentSessionMessageListStore?.messages).slice(-8).map((item) => ({
        wrapperKeys: Object.getOwnPropertyNames(item || {}).slice(0, 80),
        wrapperScalarMetadata: scalarMetadata(item),
        rawMetadata: rawMetadata(item?.kMsg?.rawMsg || item?.rawMsg),
        rawScalarMetadata: scalarMetadata(item?.kMsg?.rawMsg || item?.rawMsg),
        extraKeys: extraKeys((item?.kMsg?.rawMsg || item?.rawMsg)?.extra),
        pb: pbSummary(item?.kMsg || item),
      }))
      const result = {
        targetFound: Boolean(session),
        currentMatches: String(current?.targetId || current?.rawSession?.targetId || '') === targetId,
        session: schema(session),
        currentSession: schema(current),
        sender: schema(sender),
        senderSubBiz: String(sender?.subBiz || ''),
        methodSources,
        esState: { linkState: scalar(sdk.linkState), syncState: scalar(sdk.syncState), uid: scalar(sdk.esImSdk?.uid) },
        esMethodSources: collectSources(sdk.esImSdk, /(sendMessage|doSendMessage|recordMessage|batchSend|resend|sendLink)/i),
        apiMethodSources: collectSources(sdk.esImSdk?.api, /(send|message)/i),
        builtVariants,
        cachedMetadata,
      }
      if (concise) return {
        senderSubBiz: result.senderSubBiz,
        esState: result.esState,
        esMethodSources: result.esMethodSources,
        apiMethodSources: result.apiMethodSources,
        builtVariants: result.builtVariants,
        failedMessage: result.cachedMetadata.at(-1),
      }
      return result
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
