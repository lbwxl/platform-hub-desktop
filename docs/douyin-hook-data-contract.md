# Douyin Hook 数据契约

本文档是当前正式抖店 Hook 的对接说明。正式实现只有
`packages/douyin-hook`。上层应依赖 Hook Protocol 的归一化数据，不应依赖抖店页面内部对象或 `raw` 字段。

## 1. 执行模型与入口

抖店是 Page Hook，运行在 Electron 的同一登录 partition 中：

```text
Electron BrowserWindow / WebContents / CDP
        ↓
window.__PLATFORM_HOOK__
        ↓
HookResult<T>
```

当前页面由 manifest 路由：

| page | URL | 作用 |
| --- | --- | --- |
| `primary` | `https://im.jinritemai.com/pc_seller_v2/main/workspace` | 登录、会话、消息、转人工 |
| `products` | `https://fxg.jinritemai.com/ffa/g/list?tab=all` | 商品列表和详情，按需创建 |
| `orders` | `https://fxg.jinritemai.com/ffa/arrival-pages/home` | 商家首页官方通知 Runtime 与全店订单变化监听，lazy persistent 辅助页 |

订单页必须使用 Foundation 的 persistent auxiliary page：`HookSession.start()` 不创建它，第一次 `orders.list` 或 `orders.listen` 路由时 lazy 创建，之后保持到该 Session dispose，不参与 idle 回收。订单监听驻留抖店商家首页以复用官方通知 Runtime；客服工作台只提供会话相关订单上下文，不能作为全店订单水位来源。

## 2. 统一 Result 协议

所有 Page Hook Operation 都返回同一种 envelope：

```ts
type HookResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      error: {
        code:
          | 'LOGIN_REQUIRED'
          | 'CHALLENGE_REQUIRED'
          | 'RUNTIME_NOT_READY'
          | 'RATE_LIMITED'
          | 'NOT_SUPPORTED'
          | 'INVALID_INPUT'
          | 'PLATFORM_ERROR'
          | 'TIMEOUT'
        message: string
        retryable?: boolean
      }
    }
```

对接方必须先判断 `ok`，不要把 `error` 当成业务数据。`CHALLENGE_REQUIRED` 表示需要用户在官方页面完成验证，不能绕过。

## 3. 能力与 Operation

当前抖店 manifest 声明：

```text
auth.state
sessions.list
messages.listen
messages.history
messages.send.text
messages.send.file
products.list
products.detail
orders.list
orders.listen
handoff.targets.list
handoff.transfer
```

## 4. 认证

Operation：`auth.state`

```ts
interface HookAuthState {
  authenticated: boolean
  shopId?: string
  userId?: string
  checkedAt?: number // Unix milliseconds
}
```

```json
{
  "ok": true,
  "data": {
    "authenticated": true,
    "shopId": "257406961",
    "userId": "7588125415497571840",
    "checkedAt": 1789990906000
  }
}
```

未登录或页面 Runtime 尚未准备好时返回 `LOGIN_REQUIRED` 或 `RUNTIME_NOT_READY`。占位 ID（`0`、`-1`、空字符串）不表示已登录。

## 5. 会话

Operation：`sessions.list`

```ts
interface HookSessionSummary {
  id: string
  title: string
  unreadCount: number
  lastMessage?: string
  updatedAt?: number // Unix milliseconds
  avatarUrl?: string
}
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "conversation-1",
      "title": "测试买家",
      "unreadCount": 0,
      "lastMessage": "你好",
      "updatedAt": 1789990906000
    }
  ]
}
```

会话 ID 是后续 `messages.history`、`messages.send.*` 和转人工操作的 `conversationId`。

## 6. 消息

### 6.1 消息 DTO

```ts
type HookMessageType = 'text' | 'image' | 'file' | 'system' | 'order' | 'product' | 'unknown'
type HookMessageOrigin = 'customer' | 'human' | 'automation' | 'system' | 'unknown'
type HookMessageDeliveryStatus = 'pending' | 'sent' | 'failed'

interface HookMessage {
  id: string
  conversationId: string
  senderId?: string
  senderName?: string
  content: string
  type: HookMessageType
  direction: 'inbound' | 'outbound'
  origin: HookMessageOrigin
  deliveryStatus?: HookMessageDeliveryStatus
  timestamp: number // Unix milliseconds
  attachments?: Array<{ url?: string; name?: string; mimeType?: string }>
  raw?: unknown
}
```

`origin` 的语义：

| origin | 语义 |
| --- | --- |
| `customer` | 买家入站消息 |
| `human` | 有明确平台证据的人工发出消息 |
| `automation` | 本 Hook 调用发送的消息，或被发送关联器确认的回显 |
| `system` | 平台系统通知 |
| `unknown` | 证据不足，不做猜测 |

### 6.2 历史消息

Operation：`messages.history`

```ts
await runtime.invoke('messages.history', { conversationId: 'conversation-1' })
// HookResult<HookMessage[]>
```

### 6.3 实时消息监听

Operation：`messages.listen`

```ts
interface ListenResult {
  listening: true
  watermark: number // Unix milliseconds
}
```

监听建立时会先建立历史水位线；水位线之前的消息不会再次作为新事件发布。正式来源优先是抖店公开 Runtime 的 `_message$`、`_messageUpsert$` 和 `_batchUpsert$`，没有这些流时才使用有界历史轮询兜底。

### 6.4 发送文本

Operation：`messages.send.text`

```ts
await runtime.invoke('messages.send.text', {
  conversationId: 'conversation-1',
  text: '您好，我来为您介绍一下商品。'
})
// HookResult<HookMessage>
```

成功返回的消息方向为 `outbound`，来源为 `automation`：

```json
{
  "ok": true,
  "data": {
    "id": "server-message-id",
    "conversationId": "conversation-1",
    "content": "您好，我来为您介绍一下商品。",
    "type": "text",
    "direction": "outbound",
    "origin": "automation",
    "deliveryStatus": "sent",
    "timestamp": 1789990906000
  }
}
```

### 6.5 发送图片

Operation：`messages.send.file`

```ts
await runtime.invoke('messages.send.file', {
  conversationId: 'conversation-1',
  data: 'data:image/png;base64,...',
  name: '商品图.png',
  mimeType: 'image/png'
})
```

当前抖店官方 window Runtime 只支持图片发送；其他文件类型返回 `NOT_SUPPORTED`。

### 6.6 商品卡片消息

商品卡片消息的 `type` 为 `product`，订单卡片消息的 `type` 为 `order`：

```json
{
  "id": "message-id",
  "conversationId": "conversation-1",
  "content": "[商品]",
  "type": "product",
  "direction": "inbound",
  "origin": "customer",
  "timestamp": 1789990906000
}
```

卡片的具体平台扩展字段只放在 `raw`，业务层不要依赖 `raw` 代替统一 DTO。

## 7. 商品

### 7.1 商品 DTO

```ts
type HookProductStatus = 'on_sale' | 'off_sale' | 'draft' | 'unknown'

interface HookProduct {
  id: string
  externalId: string
  title: string
  description?: string
  status: HookProductStatus
  price?: { amount: number; currency: string }
  stockQuantity?: number
  images: string[]
  skus: Array<{
    id: string
    externalId?: string
    name: string
    price?: { amount: number; currency: string }
    stockQuantity?: number
  }>
  url?: string
  updatedAt?: number
  raw?: unknown
}
```

金额统一使用元，不是分；当前货币为 `CNY`。`status` 由 Hook 归一化，宿主不要自行根据平台状态码判断“在售”。

### 7.2 商品列表与详情

```ts
await runtime.invoke('products.list', {})
// HookResult<HookProduct[]>

await runtime.invoke('products.detail', { id: 'product-external-id' })
// HookResult<HookProduct>
```

商品列表语义是当前店铺在售商品；数据来自官方商品页已加载的 `GOODS_SWR_CACHE_V1` 状态。商品 worker 按需创建，不应由业务方长期为每个店铺保持多个页面。详情不存在时返回 `INVALID_INPUT`。

## 8. 订单

### 8.1 订单 DTO

```ts
type HookOrderStatus =
  | 'created' | 'paid' | 'processing' | 'shipped' | 'completed'
  | 'cancelled' | 'refunding' | 'refunded' | 'unknown'

interface HookOrder {
  id: string // douyin:<shopId>:<externalId>
  externalId: string // shop_order_id
  shopId?: string
  conversationId?: string
  buyer?: { id?: string; name?: string }
  status: HookOrderStatus
  items: Array<{
    productId?: string
    externalProductId?: string
    skuId?: string
    skuName?: string
    title: string
    quantity: number
    price?: { amount: number; currency: string }
  }>
  total?: { amount: number; currency: string }
  receiver?: { name?: string; phoneMasked?: string; address?: string }
  createdAt?: number
  updatedAt?: number
  raw?: unknown
}
```

订单金额单位是元，时间单位是 Unix milliseconds。买家和收件人字段可能被平台脱敏或缺省，业务层必须兼容可选字段。

### 8.2 订单列表

Operation：`orders.list`（只在 `orders` lazy persistent auxiliary page 执行）

```ts
const result = await runtime.invoke('orders.list', {})
// HookResult<HookOrder[]>
```

当前真实来源是同源官方接口：

```text
GET /api/order/searchlist?page=0&pageSize=100&order_by=create_time&order=desc&tab=all
```

这是全店订单快照，不依赖当前客服会话。订单 `raw` 中会带诊断标记 `{ "source": "fxg.order.searchlist" }`，该标记不属于业务契约。

### 8.3 订单监听

Operation：`orders.listen`（只在 `orders` lazy persistent auxiliary page 执行）

```ts
const result = await runtime.invoke('orders.listen', {})
// HookResult<{ listening: true; watermark: number }>
```

监听流程：

1. 首次读取全店订单快照并建立 watermark。
2. 实时通知有两种语义，二者都不直接决定订单状态：
   - 官方 runtime event 能真实提取 `orderId` 时，直接请求 `/api/order/searchlist?...&search_words=<orderId>` 获取该订单权威快照；索引尚未可见时只进行有限的 0 / 300 / 1000 / 2500ms 重试。
   - Electron 中页面已有的 Frontier runtime 发出已解码 `service=20132`、`method=0` frame，但没有可用 `orderId` 时，只标记 `ORDER_DOMAIN_DIRTY`。它经短 debounce 后刷新最近订单快照，不能被解释为下单、支付或退款事件。
3. 无订单号的 order-domain wakeup 在同一店铺最多保留一个 recent-order refresh in-flight。连续 frame 合并；刷新期间再到达的 frame 只安排一次后续刷新。
4. 每次 authoritative snapshot 都与本地 order snapshot 做 material diff：监听开始后才创建的未知订单发布 `order.created`；已有订单的状态、商品、金额、收件人等有意义字段变化发布 `order.updated`；买家身份和会话上下文的补全或缺失不构成订单状态变化。监听开始前的未知历史订单只建立 baseline。
5. 没有实际变化不会重复发布事件；通知重复也不会重复发布事件。`updatedAt` 和通知诊断字段不参与 material diff。
6. `getshopbroadcastv3` 和 `reach/list` 仅可用于历史、审计或订单号发现，不能作为当前订单状态真相。Frontier 也只是 wake-up signal，订单真相始终是 `/api/order/searchlist`。
7. 退款当前没有确认的 Frontier frame；通知源断开或漏通知时，每五分钟执行一次低频 reconciliation，作为退款、断连和漏 push 兜底。监听开始后新出现的订单补发 `order.created`，监听开始前的历史订单只建立 baseline。

### 8.4 订单事件

```ts
type OrderEvent =
  | { type: 'order.created'; timestamp: number; payload: { order: HookOrder } }
  | {
      type: 'order.updated'
      timestamp: number
      payload: { order: HookOrder; previous?: HookOrder; changedFields?: string[] }
    }
```

```ts
for (const event of await runtime.drainEvents()) {
  if (event.type === 'order.created') await onOrderCreated(event.payload.order)
  if (event.type === 'order.updated') {
    await onOrderChanged(event.payload.order, event.payload.previous, event.payload.changedFields)
  }
}
```

`created`、`refunding` 等是平台实际观察到的状态，不是每笔订单必经的生命周期。抖店有时会从“已付款”直接返回“退款成功”，此时不会伪造 `refunding`；`pay_time` 只在平台没有可识别状态时作为 `paid` 兜底，不能覆盖“待发货”等权威状态。

## 9. 转人工

### 9.1 目标列表

Operation：`handoff.targets.list`

```ts
interface HookHandoffTarget {
  id?: string
  name: string
}

await runtime.invoke('handoff.targets.list', {})
// HookResult<HookHandoffTarget[]>
```

目标来自当前登录客服账号在抖店官方页面实际可转列表，可能为空。

### 9.2 转接

Operation：`handoff.transfer`

```ts
await runtime.invoke('handoff.transfer', {
  conversationId: 'conversation-1',
  targetId: 'staff-1',
  // 或 targetName: '客服一'
  remark: '需要人工继续跟进'
})
// HookResult<{ transferred: true; target: HookHandoffTarget }>
```

目标不存在、会话 ID 缺失或官方转接能力不可用时返回错误，不返回伪造成功。

## 10. Electron 壳层兼容事件

如果接入的是当前 Electron 壳层而不是直接使用 Page Hook，可以通过：

```ts
window.platformApi.onEvent((event) => {
  // event.type: 'message' | 'order' | 'connection' | ...
})
```

订单事件会被壳层映射为：

```ts
interface PlatformOrderEvent {
  id: string
  accountId: string
  platform: 'douyin-shop'
  type: 'order'
  timestamp: number
  payload: {
    eventType: 'order.created' | 'order.updated'
    order: OrderRecord
    previous?: OrderRecord
    changedFields?: string[]
  }
}
```

其中 `OrderRecord` 是 Electron 兼容层 DTO；新业务优先使用上面的 `HookOrder`。壳层日志会显示事件类型和订单号，方便多店铺、多订单验收。

## 11. 不要依赖的内容

- 不要调用旧 Legacy 路径或旧客服工作台订单 probe。
- 不要把 `raw` 当成稳定公共协议。
- 不要用页面 DOM、CSS 选择器或点击行为实现 Hook 对接。
- 不要假设每笔订单都经过 `created → paid → refunding → refunded` 的每一个状态。
- 不要在上层根据抖店原始状态码自行判断订单或商品状态。

## 12. 版本与验证

当前正式包：

```text
packages/douyin-hook
```

修改 DTO、事件字段或 Operation 语义时，必须同步更新：

```text
packages/hook-sdk/src/contracts
packages/hook-sdk/src/events
tests/douyin-hook-*
```

本仓库验证命令：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
