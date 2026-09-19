const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /localhost:5173/i.test(item.url))
if (!target) throw new Error('未找到工作台页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  const timer = setTimeout(() => reject(new Error('工作台只读验收超时')), 90_000)
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
        const attempt = async (run) => {
          try { return { ok: true, value: await run() } }
          catch (error) { return { ok: false, error: String(error?.message || error) } }
        }
        const accounts = await window.platformApi.accounts.list()
        const account = accounts.find((item) => item.platform === 'douyin-shop')
        if (!account) return { ok: false, error: 'douyin-account-not-found' }
        await window.platformApi.accounts.open(account.id)
        const status = await window.platformApi.status(account.id)
        const sessionResult = await attempt(() => window.platformApi.sessions(account.id))
        const sessions = sessionResult.ok && Array.isArray(sessionResult.value) ? sessionResult.value : []
        const session = sessions[0]
        const messageResult = session
          ? await attempt(() => window.platformApi.messages(account.id, session.id))
          : { ok: true, value: [] }
        const messages = messageResult.ok && Array.isArray(messageResult.value) ? messageResult.value : []
        const orderResult = session
          ? await attempt(() => window.platformApi.syncOrders(account.id, session.id))
          : { ok: true, value: { orders: [], source: 'none', authoritative: false } }
        const productResult = await attempt(() => window.platformApi.collectProducts(account.id))
        const products = productResult.ok && Array.isArray(productResult.value) ? productResult.value : []
        const detailResult = products[0]?.goodsId
          ? await attempt(() => window.platformApi.productDetail(account.id, products[0].goodsId))
          : { ok: true, value: null }
        return {
          ok: true,
          platform: account.platform,
          connected: status.connected === true,
          authenticated: status.authenticated === true,
          sessions: {
            ok: sessionResult.ok,
            count: sessions.length,
            shapeValid: sessions.every((item) => typeof item.id === 'string' && typeof item.title === 'string'),
            error: sessionResult.error,
          },
          messages: {
            ok: messageResult.ok,
            count: messages.length,
            shapeValid: messages.every((item) => typeof item.id === 'string' && typeof item.sessionId === 'string' && Number.isFinite(item.timestamp)),
            error: messageResult.error,
          },
          orders: {
            ok: orderResult.ok,
            count: orderResult.value?.orders?.length || 0,
            source: orderResult.value?.source,
            authoritative: orderResult.value?.authoritative === true,
            error: orderResult.error,
          },
          products: {
            ok: productResult.ok,
            count: products.length,
            shapeValid: products.every((item) => typeof item.goodsId === 'string' && Array.isArray(item.images)),
            error: productResult.error,
          },
          productDetail: {
            ok: detailResult.ok,
            available: Boolean(detailResult.value?.goodsId),
            error: detailResult.error,
          },
        }
      })()`,
    },
  }))
})

console.log(JSON.stringify(result, null, 2))
socket.close()
