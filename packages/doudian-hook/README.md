# @platform-hub/doudian-hook

抖店客服页的纯前端 CDP Hook 包。它只负责在已登录的抖店页面中读取官方 `window` runtime、归一化数据并暴露方法与事件；不保存订单、不写入业务数据库、不依赖某个宿主后端。

接入方可以是 Electron、Playwright/CDP 服务、浏览器插件宿主或其它支持 `Runtime.evaluate` 的系统。订单事件由接入方自行写入自己的订单库。

完整方法、类型和数据示例见 [API.md](./API.md)。

## 安装

```bash
pnpm add @platform-hub/doudian-hook
```

包导出：

- `createDoudianClient(evaluate)`：基于 CDP `Runtime.evaluate` 的 typed client；
- `doudianHook`：可发现的 manifest；
- `doudianHookScript`：独立 IIFE runtime；
- `OrderRecord`、`OrderEventPayload`、`OrderSyncResult` 等 TypeScript 类型。

## 最小接入

```ts
import { createDoudianClient } from '@platform-hub/doudian-hook'

const client = createDoudianClient(async (expression) => {
  // 宿主实现：在抖店 WebContents / CDP 页面执行 Runtime.evaluate。
  return evaluateInCdpPage(expression)
})

await client.install()
await client.waitForLogin()

const stop = client.subscribeOrders((event) => {
  // 由接入方写入自己的订单库；Hook 不会替你保存。
  void orderRepository.upsert(event.order).catch(console.error)
})

const sessions = await client.listSessions()
await client.syncOrders(sessions[0]?.id)

// 宿主退出时释放 timer 和页面订阅。
stop()
await client.dispose()
```

## 约束

- 登录只观察官方页面状态，由用户完成登录；
- 只通过 CDP `Runtime.evaluate` 调用页面 `window` 上暴露的能力；
- 不查询或操作 DOM，不模拟点击，不拦截 fetch/XHR/WebSocket；
- 不调用外部业务后端，不持久化订单或消息；
- 订单监听会在新会话消息到达或显式调用 `syncOrders` 后建立快照，并通过 `subscribeOrders` 推送新增和字段变化。
