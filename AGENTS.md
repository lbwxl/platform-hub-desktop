# AGENTS.md

## 1. Project Goal

本项目正在重构为统一的 Platform Hook 系统。

目标平台：

* 抖店
* 快手小店
* 拼多多
* 闲鱼

开发顺序：

```text
抖店
↓
快手
↓
拼多多
↓
闲鱼
```

一次只实现一个平台。

当前重构的核心目标不是“尽快支持所有平台”，而是：

> 建立统一、稳定、可扩展的 Hook Protocol，使不同平台只存在实现差异，不存在架构差异。

---

# 2. Hook Responsibilities

Hook 只负责“平台事实”。

核心能力：

## Messaging

* 获取会话
* 获取历史消息
* 接收新消息
* 发送文本消息
* 发送图片 / 文件（平台支持时）

## Products

* 获取当前在售商品
* 获取商品详情
* SKU
* 价格
* 库存
* 商品状态

## Orders

* 获取订单快照
* 感知用户新下单
* 感知付款
* 感知取消
* 感知发货
* 感知完成
* 感知退款
* 感知订单状态及重要字段变化

订单信息必须保持尽可能新，防止 AI 使用过期订单状态回复用户。

---

# 3. Hook Must NOT Handle

Hook 不负责：

* AI 回复
* Prompt
* 知识库
* 关键词
* 业务数据库
* 用户系统
* 店铺业务管理
* 计费
* 业务后端
* Aichat Core 业务决策

Hook 只负责平台能力。

---

# 4. Architecture

目标架构：

```text
Aichat Core
    ↓
Aichat Platform SDK
    ↓
Platform Adapter
    ↓
HookSession
    ↓
Hook SDK
    ↓
Specific Platform Hook
    ↓
Official Platform Runtime
```

Electron 提供：

```text
HookHost
├─ Primary Page
├─ Worker Pages
├─ CDP
├─ BrowserWindow / WebContents
├─ Partition
└─ Runtime lifecycle
```

---

# 5. Dependency Rules

Hook SDK 不允许依赖：

* Electron
* React
* Vue
* Aichat Core
* 具体平台 Hook

具体平台 Hook可以依赖：

```text
hook-sdk
```

HookHost 可以依赖：

```text
hook-sdk
Electron
```

禁止：

```text
doudian-hook → kuaishou-hook

kuaishou-hook → pinduoduo-hook
```

平台之间不能互相依赖。

---

# 6. Packages

目标目录：

```text
packages/

  hook-sdk/
    src/
      manifest/
      protocol/
      capabilities/
      contracts/
      events/
      errors/
      testing/

  hook-host/
    src/
      session/
      pages/
      transport/
      scheduler/
      events/

  hooks/

    douyin/
      src/
        manifest.ts
        pages/
        capabilities/
        adapters/
        platform/
      tests/

    kuaishou/

    pinduoduo/

    goofish/
```

目录允许根据实际代码微调，但架构边界不能破坏。

---

# 7. Hook SDK

所有平台必须遵守同一套 Hook SDK。

必须包含：

* HookManifest
* HookCapability
* HookOperation
* HookPageDefinition
* HookResult
* HookError
* HookEvent
* HookMessage
* HookProduct
* HookOrder

不得让每个平台自己定义另一套公共协议。

---

# 8. Capabilities

首版公共 Capability：

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
```

不要提前加入大量平台特例。

如果具体平台出现特殊能力：

先判断是否是真正的跨平台通用能力。

不是通用能力：

保留在具体 Platform Hook 内部。

---

# 9. Manifest Driven

每个平台必须通过 HookManifest 声明：

* 平台
* 版本
* Capability
* Pages
* Operation → Page 路由

例如：

```ts
operations: {
  'messages.send.text': {
    page: 'primary'
  },

  'products.list': {
    page: 'products'
  },

  'orders.list': {
    page: 'orders'
  }
}
```

HookHost 根据 Manifest 决定在哪个页面运行 Operation。

禁止 HookHost 出现：

```ts
if (platform === 'douyin') {}
```

禁止：

```ts
switch (platform) {}
```

---

# 10. Multi Page Runtime

一个店铺 HookSession 可以拥有：

```text
primary
+
0..N worker pages
```

例如：

```text
Shop Session

├─ primary
│  └─ 客服工作台

├─ products
│  └─ 商品页面

└─ orders
   └─ 订单页面
```

所有页面必须共享同一个店铺 Partition。

---

# 11. Worker Page Rules

Worker Page 必须：

* 按需创建
* 可复用
* 支持 Abort
* 支持 Timeout
* 空闲自动回收
* 有全局并发限制

禁止：

> 每个店铺长期保持 products + orders Worker。

未来需要支持几十到上百个店铺，因此 Worker Page 必须节约 Chromium 资源。

---

# 12. Worker Scheduler

HookHost 内必须存在统一 WorkerScheduler。

负责：

* 并发
* 队列
* 优先级
* Worker Page 创建
* Worker Page 复用
* Worker Page 回收
* Timeout
* Abort

默认优先级：

```text
消息
>
订单
>
商品
```

商品同步不得影响消息实时性。

---

# 13. Page Runtime Protocol

页面内统一只暴露：

```ts
window.__PLATFORM_HOOK__
```

统一 Protocol：

```ts
interface PageHookRuntime {
  protocolVersion: number

  describe(): HookRuntimeDescription

  invoke(
    operation: string,
    input: unknown
  ): Promise<HookResult<unknown>>

  drainEvents(): HookEvent[]

  dispose(): Promise<void>
}
```

不要让公共层直接依赖：

```text
collectProducts()
sendMessage()
getOrders()
```

等平台函数。

---

# 14. Method-level RPC

旧架构中的：

```ts
createDoudianClient(evaluate)
```

不得作为新版核心协议。

新版使用：

```ts
session.invoke(
  operation,
  input
)
```

例如：

```ts
session.invoke(
  'products.list',
  {}
)
```

HookHost 必须知道：

```text
operation
input
target page
```

而不是只收到任意 JavaScript expression。

---

# 15. Result Protocol

统一：

```ts
type HookResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: HookError
    }
```

禁止不同平台返回不同风格：

```text
success
ok
errorCode
error
```

---

# 16. Error Protocol

至少支持：

```text
LOGIN_REQUIRED

CHALLENGE_REQUIRED

RUNTIME_NOT_READY

RATE_LIMITED

NOT_SUPPORTED

INVALID_INPUT

PLATFORM_ERROR

TIMEOUT
```

---

# 17. Challenge / Slider Verification

不得尝试绕过平台官方验证码或滑块。

商品采集等操作遇到验证时：

```text
Operation
↓
CHALLENGE_REQUIRED
↓
HookHost 显示对应 Worker Page
↓
用户完成官方验证
↓
等待 Runtime 恢复
↓
重新安装 Hook
↓
恢复原 Operation
```

Challenge 是可恢复状态，不是普通采集失败。

---

# 18. Message Contract

所有平台最终必须输出统一 HookMessage。

平台内部字段必须在 Platform Hook 内进行 Normalize。

原始数据可以放：

```text
raw
```

但业务层不得依赖平台 raw 字段。

---

# 19. Product Contract

所有平台最终必须输出统一 HookProduct。

`products.list` 默认语义：

> 返回当前店铺在售商品。

具体平台如何识别“在售”，属于平台 Hook 的内部实现。

不得让宿主根据平台 status 字段判断。

---

# 20. Order Contract

所有平台最终必须输出统一 HookOrder。

统一状态：

```text
created
paid
processing
shipped
completed
cancelled
refunding
refunded
unknown
```

平台原始状态必须在 Platform Hook 内完成 Normalize。

---

# 21. Order State Awareness

订单是核心能力。

必须保证：

```text
订单 Snapshot
+
订单变化监听
```

启动监听前先获取 Snapshot / Watermark。

不能把历史订单误判为新订单。

统一事件：

```text
order.created
order.updated
```

订单没有实际变化：

不得重复发事件。

---

# 22. Event Model

公共事件至少包括：

```text
message.created

order.created

order.updated

auth.changed

runtime.error
```

上层统一通过：

```ts
session.subscribe(listener)
```

监听。

---

# 23. Event Performance

不要让每个平台 Client 自己随意创建大量：

```ts
setInterval(...)
```

统一由 Host 层负责事件调度。

优先使用：

1. 平台官方 Runtime Event
2. 平台 SDK Event
3. 必要时 Adaptive Polling

Polling 必须：

* 防止重入
* 可取消
* 根据活跃度降频
* Runtime 停止时自动释放

---

# 24. Product Performance

商品 Worker：

* 只有同步时创建
* 尽量复用
* 空闲自动销毁
* 同时同步的店铺数量必须有限制

不要同时给大量店铺打开商品页面。

商品详情优先：

```text
列表已有数据
+
按需获取 Detail
```

不要无条件请求所有商品详情。

---

# 25. FakeHook First

在正式实现抖店之前，必须完成：

```text
FakeHook
```

FakeHook 至少模拟：

* 登录
* 会话
* 收消息
* 发消息
* 商品列表
* 商品详情
* 新订单
* 订单状态改变
* CHALLENGE_REQUIRED
* Challenge Recovery

FakeHook 必须运行真实 Hook Protocol。

---

# 26. Contract Tests

所有正式平台必须通过相同 Contract Test。

至少测试：

* Manifest
* Capability
* Operation Page Routing
* Runtime install
* Runtime dispose
* start / stop
* 重复 stop
* 店铺隔离
* Worker 创建
* Worker 回收
* Message DTO
* Product DTO
* Order DTO
* order.created 去重
* order.updated 去重
* Challenge Recovery
* Runtime Failure Isolation

---

# 27. Platform Development Order

严格：

```text
基础架构
↓
FakeHook
↓
抖店
↓
快手
↓
拼多多
↓
闲鱼
```

抖店没有完全验收：

禁止开始快手。

---

# 28. Legacy Hook

旧 Hook 代码必须先通过 Branch 或 Git Tag 保存。

Legacy Hook 只作为：

* Runtime 探索参考
* 已验证调用方式参考
* 字段参考
* 测试参考

不要复制旧架构。

---

# 29. Development Workflow

每次开发之前：

1. 阅读 AGENTS.md
2. 阅读当前 Phase
3. 阅读已有代码
4. 阅读 Legacy Hook 对应能力
5. 判断属于 SDK / Host / Platform Hook 哪一层
6. 明确修改哪些文件
7. 再编码

---

# 30. Current Phase Rule

除非用户明确要求：

只执行当前指定 Phase。

不得“顺便”开始后面的平台。

完成当前 Phase 后停止。

---

# 31. Git Rules

允许：

* 修改代码
* 创建文件
* 删除已被新架构替代的本地代码
* 运行测试
* 创建 commit

未经用户明确要求：

* 禁止 push
* 禁止 force push
* 禁止删除远程分支
* 禁止修改生产环境

---

# 32. Completion Report

每个 Phase 完成必须汇报：

* 完成内容
* 新增文件
* 修改文件
* 删除文件
* 当前目录结构
* 架构变化
* 测试结果
* TypeScript typecheck
* 当前技术债
* 下一阶段建议

---

# 33. Highest Priority Rule

如果：

```text
快速实现当前功能
```

和：

```text
保持统一 Hook 抽象
```

发生冲突：

优先保持统一 Hook 抽象。

不要为了快速支持抖店而在 HookHost / hook-sdk 中加入抖店特例。
