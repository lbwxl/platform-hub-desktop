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
  const timer = setTimeout(() => reject(new Error('快手扩展参数诊断超时')), 30_000)
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
      let sdk = window.__chat_sdk
      try { for (let index = 0; !sdk && index < Math.min(window.frames.length, 12); index += 1) sdk = window.frames[index].__chat_sdk } catch (_) {}
      if (!sdk) return { error: 'chat-sdk-not-found' }
      const targetId = ${JSON.stringify(targetId)}
      const sessions = sdk.sessionModel?.sessionAllModel?.allSessionMap
      const session = typeof sessions?.get === 'function' ? sessions.get(targetId) : sessions?.[targetId]
      const current = sdk.currentSessionMessageListStore?.session
      const rawSession = current?.rawSession || current?.cachedSession
      const uid = sdk.esImSdk?.uid
      const loginUser = sdk.store?.state?.loginUserInfo || {}
      const assistantId = session?.assistantId || loginUser?.assistantId
      const variants = [
        { name: 'empty', extra: {} },
        { name: 'role-device', extra: { realFromRole: 1, device: 4 } },
        { name: 'role-device-sdk-uid', extra: { realFromRole: 1, device: 4, senderUserId: uid } },
        { name: 'role-device-login-user', extra: { realFromRole: 1, device: 4, senderUserId: loginUser.userId } },
        { name: 'role-device-sdk-uid-assistant', extra: { realFromRole: 1, device: 4, senderUserId: uid, assistantId } },
        { name: 'role-device-login-user-assistant', extra: { realFromRole: 1, device: 4, senderUserId: loginUser.userId, assistantId } },
      ]
      const id = (value) => {
        if (value == null) return ''
        try { return String(value) } catch (_) { return '' }
      }
      const summarize = (value) => {
        const merchant = value?.eExtra?.bizExtras?.MERCHANT
        let pb
        try { pb = value?.toPbMessage?.() } catch (_) {}
        return {
          realFromRole: merchant?.realFromRole,
          sourcePage: merchant?.sourcePage,
          device: merchant?.device,
          senderUserId: id(merchant?.senderUserId),
          assistantId: id(merchant?.assistantId),
          extraBytes: pb?.extra?.byteLength ?? pb?.extra?.length,
        }
      }
      const results = []
      for (const variant of variants) {
        try {
          const message = await sdk.messageSender.sendTextMsg({
            targetType: Number(session?.chatTargetType || rawSession?.chatTargetType || 0),
            targetId,
            text: 'probe',
            extra: variant.extra,
          }, true)
          results.push({ name: variant.name, ...summarize(message) })
        } catch (error) { results.push({ name: variant.name, error: String(error?.message || error) }) }
      }
      return { results }
    })()`,
  },
}))
console.log(JSON.stringify(await answer, null, 2))
socket.close()
