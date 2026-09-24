import { readFile } from 'node:fs/promises'

const runtime = await readFile(new URL('../packages/legacy-kuaishou-hook/dist/runtime.js', import.meta.url), 'utf8')
const targets = await fetch('http://127.0.0.1:9333/json/list').then((response) => response.json())
const target = targets.find((item) => /im\.kwaixiaodian\.com\/workbench/i.test(item.url))
if (!target) throw new Error('未找到快手小店 CDP 页面')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
function evaluate(expression) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('快手订单同步验收超时')), 30_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression } }))
  })
}

await evaluate(runtime)
const result = await evaluate(`(async () => {
  const api = window.__platformHub
  const auth = await api?.getAuthState?.()
  const sessions = await api?.listSessions?.() || []
  const session = sessions.find((item) => item.title === '拾一见月')
  const initialEvents = await api?.drainEvents?.() || []
  const directOrders = session ? await api.getOrders(session.id) : []
  const sync = session ? await api.syncOrders(session.id) : { orders: [], authoritative: false, source: 'none' }
  return {
    hookVersion: api?.__version,
    authenticated: auth?.authenticated === true,
    sessionFound: Boolean(session),
    initialOrderEventCount: initialEvents.filter((event) => event.type === 'order').length,
    authoritative: sync.authoritative === true,
    source: sync.source,
    orderCount: sync.orders?.length || 0,
    directOrders: Array.isArray(directOrders) ? directOrders.slice(0, 3).map((order) => ({ orderId: order.orderId, status: order.status, totalAmount: order.totalAmount, quantity: order.quantity, productName: order.productName, raw: order.raw })) : directOrders,
    orders: (sync.orders || []).slice(0, 10).map((order) => ({
      status: order.status,
      totalAmount: order.totalAmount,
      quantity: order.quantity,
      productName: order.productName,
      updatedAt: order.updatedAt,
    })),
  }
})()`)

console.log(JSON.stringify(result, null, 2))
socket.close()
