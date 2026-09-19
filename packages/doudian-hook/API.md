# 抖店 Hook 接口文档

版本：`3.5.0`（npm 包：`0.3.0`）

## 1. 宿主职责

宿主只需要提供一个 `CdpEvaluate`：在已打开的抖店客服页面中执行 CDP `Runtime.evaluate`，并设置：

```ts
type CdpEvaluate = <T>(expression: string) => Promise<T>
```

建议的 CDP 参数：`awaitPromise: true`、`returnByValue: true`、`userGesture: true`。Hook 不要求宿主提供数据库、HTTP 后端或平台私有请求客户端，Hook 自己不保存订单；接入方通过事件回调写入自己的订单库。

## 2. 创建客户端与生命周期

```ts
import { createDoudianClient } from '@platform-hub/doudian-hook'

const client = createDoudianClient(evaluateInCdpPage)
await client.install()
const auth = await client.waitForLogin({ timeoutMs: 15 * 60_000, intervalMs: 1000 })
```

生命周期顺序：

1. `install()`：幂等注入 `window.__platformHub`；
2. `getAuthState()` / `waitForLogin()`：读取登录状态；
3. 调用业务方法或建立 `subscribe()` / `subscribeOrders()`；
4. 宿主销毁时调用 `dispose()`。

重复 `install()` 会先释放旧 Hook 的订阅和 timer，不会叠加监听。

## 3. 方法入口

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `install()` | `Promise<void>` | 注入页面 runtime |
| `getAuthState()` | `Promise<AuthState>` | 当前登录状态 |
| `waitForLogin(options?)` | `Promise<AuthState>` | 等待用户在官方页面完成登录 |
| `listSessions()` | `Promise<ChatSession[]>` | 会话列表 |
| `listMessages(sessionId)` | `Promise<PlatformMessage[]>` | 会话历史消息 |
| `sendMessage(sessionId, content)` | `Promise<OperationResult>` | 发送文本 |
| `sendFile(sessionId, dataUrl, fileName?)` | `Promise<OperationResult>` | 使用平台上传能力发送图片 |
| `collectProducts()` | `Promise<ProductRecord[]>` | 商品页缓存采集 |
| `getProductDetail(goodsId)` | `Promise<ProductRecord>` | 商品详情 |
| `getOrders(userId?)` | `Promise<OrderRecord[] \| OperationResult>` | 读取平台当前暴露的订单列表 |
| `syncOrders(sessionId?, userId?)` | `Promise<OrderSyncResult>` | 合并平台订单、会话订单卡和当前工作台订单，并建立订单监听快照 |
| `subscribe(listener, options?)` | `() => void` | 订阅所有 Hook 事件 |
| `subscribeOrders(listener, options?)` | `() => void` | 只订阅订单事件 |
| `drainEvents()` | `Promise<HookEvent[]>` | 手动取走事件队列 |
| `diagnose()` | `Promise<...[]>` | 只读能力诊断 |
| `dispose()` | `Promise<void>` | 释放订阅、timer 和页面 Hook |

`subscribe` 和 `subscribeOrders` 的 `options.intervalMs` 默认是 `800` 毫秒，仅表示宿主从页面事件队列取数据的频率，不会改变抖店页面内部的消息流。

## 4. 订单监听语义

订单监听只负责把页面变化交给宿主，宿主决定是否入库：

```ts
const stop = client.subscribeOrders((event: OrderEventPayload) => {
  void orderRepository.upsert({
    accountId: shopAccountId,
    order: event.order,
    sessionId: event.sessionId,
    userId: event.userId,
    source: event.source,
  }).catch(console.error)
})
```

监听来源包括：

- 新到达的抖店订单卡消息；
- `syncOrders()` 得到的平台订单快照；
- 订单状态、数量、金额、SKU 或收货信息发生变化的平台快照。

相同买家会话内，同一 `orderId` 的重复订单卡不会重复推送；字段变化会按新的订单状态推送。Hook 只保留受限的内存快照：最多 50 个买家、活跃期 2 分钟内约 5 秒检查一次，闲置后约 30 秒检查一次，最长保留 30 分钟。宿主若需要长期监听，应保持自己的订阅和订单库。

建议在两种时机调用 `syncOrders`：

- 宿主刚接管一个买家会话时，用于把已有订单作为初始数据交给订单库；
- 买家发送“改颜色、改地址、改数量”等售后消息时，用于刷新该会话订单上下文。

## 5. 核心类型

```ts
interface OrderRecord {
  id: string                 // douyin-shop;<shopId>;<orderId>
  orderId: string
  skuOrderId?: string
  skuId?: string
  skuName?: string
  status?: string
  totalAmount?: number       // 元，不是分
  quantity?: number
  productId?: string
  productName?: string
  productImage?: string
  orderUrl?: string
  buyerName?: string
  receiverName?: string
  shippingAddress?: string
  shopId?: string
  sessionId?: string
  userId?: string
  messageId?: string
  updatedAt?: number         // Unix milliseconds
  platform: 'douyin-shop'
  raw?: Record<string, unknown>
}

interface OrderEventPayload {
  order: OrderRecord
  sessionId: string
  userId?: string
  messageId?: string
  source: 'message' | 'platform-runtime' | 'session-history' | 'workstation' | 'combined'
  timestamp: number          // Unix milliseconds
}

interface OrderSyncResult {
  orders: OrderRecord[]
  authoritative: boolean
  source: 'session-history' | 'platform-runtime' | 'workstation' | 'combined' | 'none'
  syncedAt: number
  sessionId?: string
  userId?: string
  errorCode?: string
  error?: string
}
```

平台没有暴露的字段会省略，不会猜测。`shippingAddress`、`receiverName` 等字段只有在抖店 runtime 提供时才会返回。

## 6. 返回示例

### 登录状态

```json
{
  "authenticated": true,
  "shopId": "257406961",
  "userId": "221427355615371"
}
```

### `syncOrders()`

```json
{
  "orders": [
    {
      "id": "douyin-shop;257406961;6929557946856668323",
      "orderId": "6929557946856668323",
      "skuId": "10001",
      "skuName": "黑色 / XL",
      "status": "待发货",
      "totalAmount": 99.9,
      "quantity": 1,
      "productId": "3789952270377025729",
      "productName": "直筒裤加绒宽松型休闲裤冬季防风保暖高腰户外",
      "sessionId": "buyer-session-id",
      "userId": "buyer-id",
      "updatedAt": 1789630716235,
      "platform": "douyin-shop"
    }
  ],
  "authoritative": true,
  "source": "combined",
  "syncedAt": 1789630717000,
  "sessionId": "buyer-session-id",
  "userId": "buyer-id"
}
```

### `subscribeOrders()`

```json
{
  "order": {
    "id": "douyin-shop;257406961;6929557946856668323",
    "orderId": "6929557946856668323",
    "skuName": "黑色 / XL",
    "status": "待发货",
    "quantity": 1,
    "productName": "直筒裤加绒宽松型休闲裤冬季防风保暖高腰户外",
    "sessionId": "buyer-session-id",
    "userId": "buyer-id",
    "updatedAt": 1789630716235,
    "platform": "douyin-shop"
  },
  "sessionId": "buyer-session-id",
  "userId": "buyer-id",
  "source": "platform-runtime",
  "timestamp": 1789630716235
}
```

### 错误

```json
{
  "ok": false,
  "errorCode": "LOGIN_REQUIRED",
  "error": "请在抖店页面完成登录后继续"
}
```

常见错误码：`LOGIN_REQUIRED`、`RUNTIME_NOT_READY`、`UNSUPPORTED_FILE_TYPE`、`TARGET_NOT_FOUND`、`RUNTIME_ERROR`。

## 7. 直接使用 runtime

不使用 typed client 的宿主可以读取 `manifest.json` 的 `entry`，将 `dist/runtime.js` 注入页面。注入后入口为：

```ts
window.__platformHub.getAuthState()
window.__platformHub.syncOrders(sessionId, userId)
window.__platformHub.drainEvents()
window.__platformHub.dispose()
```

`window.__platformHub` 只属于当前抖店页面上下文；宿主关闭或导航时必须重新 `install()`。
