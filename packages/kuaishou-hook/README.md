# @platform-hub/kuaishou-hook

快手小店的 CDP window runtime 适配包。包本身不依赖 Electron，只要求宿主提供一个执行 CDP `Runtime.evaluate` 的函数。

```ts
import { createKuaishouClient } from '@platform-hub/kuaishou-hook'

const client = createKuaishouClient((expression) => evaluateInCdpPage(expression))
await client.install()
await client.waitForLogin()
const sessions = await client.listSessions()
const stop = client.subscribe((event) => console.log(event))

// AI 回复订单问题前主动同步。authoritative=false 时不能把“未查到”解释为“已取消”。
const orderState = await client.syncOrders(sessions[0].id)
const stopOrders = client.subscribeOrders((event) => {
  console.log('订单状态通知', event.order.orderId, event.order.status)
})
```

默认消息页是 `https://im.kwaixiaodian.com/workbench`，商品页是 `https://s.kwaixiaodian.com/zone/goods/v1/list`。登录由用户在快手官方页面完成。

运行时只访问 `window` 上已公开的 SDK、store、service 和方法，不读取或操作 DOM，不拦截 fetch/XHR/WebSocket。

订单能力包含 `orders.read` 和 `orders.listen`。`orders.listen` 同时由客服消息中的订单卡和快手官方 window SDK 的订单快照增量驱动，因此没有产生客服订单卡的新订单或状态变化也会发布独立 `order` 事件。订单卡消息到达时，Hook 会同时发布标准 `message` 与独立 `order` 事件，并按 `orderId + status + messageId` 去重；安装时先建立历史水位线，旧订单不会冒充新订单。`syncOrders(sessionId, userId?)` 会合并快手 window SDK 的订单查询结果和会话订单卡，返回 `orders`、`authoritative`、`source` 与 `syncedAt`。
