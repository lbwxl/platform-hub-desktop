# AGENTS.md

## 1. Project Goal

本项目正在重构为统一的 Platform Runtime 系统，最终承载两类平台能力。

## Page / CDP 平台

```text
Douyin
Kuaishou
Pinduoduo
Goofish
```

执行模型：

```text
Page Hook
↓
HookSession
↓
HookHost
↓
BrowserWindow / WebContents / CDP
```

## Legacy / Native / Service 平台

```text
WeChat
WeWork
Qianniu
```

这类平台优先复用现有 `aichat-vue` / Legacy `aichatclient` 中已经成熟的 Hook、Bridge、MessageServer 和 Aliwork 实现，通过 Adapter / Transport 对上层提供统一 Contract。

不得为了统一形式强制把 Legacy / Native / Service 平台改造成 `PageHookRuntime`。

一次只推进当前开发顺序中的一个阶段。

当前重构的核心目标是：

> 建立统一、稳定、可扩展的 Platform / Hook Transport Contract；允许不同平台采用符合其真实运行环境的执行模型，并把差异限制在具体 Transport / Adapter 内。

---

# 2. Hook Responsibilities

Hook / Transport 只负责“平台事实”。

可声明的能力如下；每个平台只实现真实支持的子集：

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

Hook / Transport 只负责平台能力。

---

# 4. Architecture

最终总体架构：

```text
Aichat Core
    ↓
Aichat Platform SDK
    ↓
PlatformRuntime
    ↓
Platform Adapter
    ↓
HookTransport
    │
    ├─ PageHookTransport
    │      ↓
    │   HookSession
    │      ↓
    │   HookHost
    │      ↓
    │   BrowserWindow / WebContents / CDP
    │      ↓
    │   Douyin / Kuaishou / Pinduoduo / Goofish
    │
    └─ Legacy / Native Transport
           ↓
        Legacy Adapter
           ↓
        existing implementation
           ├─ WeChat DLL / Python / TCP / MessageServer
           ├─ WeWork DLL / Python / TCP / MessageServer
           └─ Qianniu / Aliwork existing implementation
```

`HookTransport` 是执行方式无关的边界，设计方向如下：

```ts
interface HookTransport {
  start(): Promise<void>

  invoke<T>(
    operation: HookOperation | string,
    input?: unknown,
    options?: HookInvokeOptions
  ): Promise<HookResult<T>>

  subscribe(
    listener: (event: HookEvent) => void
  ): () => void

  stop(): Promise<void>
}
```

网页平台：

```text
HookTransport
↓
PageHookTransport
↓
HookSession
```

微信：

```text
HookTransport
↓
WechatLegacyTransport
↓
原 WeChat 实现
```

企微、千牛使用对应的 Legacy Transport / Adapter。

`HookHost` 只是 Page / CDP 执行模型的宿主，不是所有平台的统一宿主。

Page / CDP 执行模型中的 Electron Host 提供：

```text
HookHost
├─ HookSession
│  ├─ Primary Page
│  ├─ Persistent Auxiliary Pages
│  │  └─ PersistentPageManager
│  └─ Worker Pages / WorkerScheduler
├─ CDP
├─ BrowserWindow / WebContents
├─ Partition
└─ Runtime lifecycle
```

一个 Page Hook `HookSession` 内的页面模型明确分为：

```text
primary     唯一主页面
persistent  lazy create + Session 生命周期内长期存活 + 不参与 idle 回收的辅助页面
worker      按 Operation 按需创建、空闲回收的页面
```

Persistent page 不是把 worker 的 `idleTtlMs` 设为无限，而是由
`PersistentPageManager` 独立负责创建、复用、Runtime 安装、事件接收、刷新和释放。

本节中的 `HookTransport` 只定义未来方向。当前 Phase 不实现该抽象。

---

# 5. Dependency Rules

Hook SDK 不允许依赖：

* Electron
* React
* Vue
* Aichat Core
* 具体平台 Hook

Page Hook 平台的具体 Hook 可以依赖：

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
platform-hook-a → platform-hook-b

kuaishou-hook → pinduoduo-hook
```

平台之间不能互相依赖。

平台差异必须停留在具体 Transport / Adapter。Core 不得直接调用 WeChat MessageServer、WeWork Bridge 或 Qianniu Aliwork。

禁止伪造执行模型：

```text
WeChat → fake BrowserWindow
WeWork → fake PageHookRuntime
Qianniu → fake HookPageDefinition
```

禁止在 HookHost 中加入：

```ts
if (platform === 'wechat') {}
if (platform === 'wework') {}
if (platform === 'qianniu') {}
```

---

# 6. Packages

当前 Page Hook Foundation 的目标目录：

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

未来 `PlatformRuntime`、`HookTransport` 和 Legacy Adapter 的具体包目录在对应 Phase 决定。本阶段只记录边界，不创建目录或实现代码。

---

# 7. Hook SDK

所有平台必须对上层提供统一 Platform / Hook Transport Contract，但并非所有平台都必须使用 `PageHookRuntime`、`HookSession` 或 `HookHost`。

Page Hook 平台继续遵循现有：

```text
HookManifest
PageHookRuntime
HookSession
HookHost
```

Legacy / Native / Service 平台通过 Adapter / Transport 输出统一能力，不需要伪造 Page、Manifest 路由或 Browser Runtime。

所有执行模型共同使用或映射到统一的上层类型：

* HookCapability
* HookOperation
* HookResult
* HookError
* HookEvent
* HookMessage
* 平台实际支持时的 HookProduct
* 平台实际支持时的 HookOrder

不得让每个平台自己定义另一套公共协议。

---

# 8. Capabilities

Capability 是可选集合。平台只声明和实现真实能力，不要求所有平台拥有相同能力。

当前能力矩阵：

```text
Douyin
auth       ✅
messaging  ✅
products   ✅
orders     ✅
handoff    ✅

WeChat
auth       ✅
messaging  ✅
products   ❌
orders     ❌
handoff    按实际能力

WeWork
auth       ✅
messaging  ✅
products   ❌
orders     ❌
handoff    按实际能力
```

Page Hook 首版公共 Capability 包括：

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

禁止为不具备商品或订单能力的平台创建假的 Product / Order Capability、空实现或伪造 DTO。

不要提前加入大量平台特例。

如果具体平台出现特殊能力：

先判断是否是真正的跨平台通用能力。

不是通用能力：

保留在具体 Platform Hook 内部。

---

# 9. Manifest Driven

每个 Page Hook 平台必须通过 HookManifest 声明：

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

HookHost 根据 Page Hook Manifest 决定在哪个页面运行 Operation。

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

本节只适用于 Page / CDP 平台。

一个店铺 HookSession 可以拥有：

```text
primary
+
0..N persistent auxiliary pages
+
0..N worker pages
```

例如：

```text
Shop Session

├─ primary
│  └─ 客服工作台

├─ orders (persistent)
│  └─ fxg 商家后台壳层 / 官方通知 Runtime

└─ products (worker)
   └─ 按需创建的商品页面
```

语义必须明确：

* `primary`：每个 Session 唯一的主页面。
* `persistent`：lazy create；首次路由到该页面的 Operation 时创建，之后保持到 Session dispose，由 `PersistentPageManager` 管理。
* `worker`：按 Operation acquire/release，空闲后可回收的页面。

所有页面必须共享同一个店铺 Partition；persistent 与 worker 不能跨店铺共享。

---

# 11. Worker / Persistent Page Rules

本节只适用于 Page / CDP 平台。

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

Persistent Page 必须：

* 在 `HookPageDefinition.kind` 中显式声明为 `persistent`
* 由当前 Session 的 `PersistentPageManager` 独立管理
* 默认采用 lazy create；`HookSession.start()` 只准备 Manager，不得因为 Manifest 声明 persistent page 就创建页面
* 第一次路由到该页面的 Operation 时才 `ensure()` 创建
* 创建后安装并校验 `PageHookRuntime` 协议
* 在 Session 生命周期内保持存活，不参与 WorkerScheduler 的空闲回收
* 支持 push event 订阅和 `drainEvents()` polling fallback
* 支持 Runtime refresh、Challenge Recovery、Timeout 和取消后的安全恢复
* 在 Session dispose 时先释放 Runtime，再关闭页面

Persistent Page 一旦创建就保持到 `HookSession.dispose()`；不得通过“Worker + 无限 `idleTtlMs`”隐式实现，也不得和其他店铺共享页面或 Partition。

---

# 12. Worker Scheduler

本节只适用于 Page / CDP 平台。HookHost 内必须存在统一 WorkerScheduler。

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

本节只适用于 Page / CDP 平台。

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

  drainEvents(): Promise<HookEvent[]>

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

本节描述 Page / CDP 平台的内部 RPC。其他执行模型仍通过 `HookTransport.invoke()` 向上提供相同 Operation 语义。

旧架构中的：

```ts
createLegacyClient(evaluate)
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

本节只适用于需要页面官方验证的 Page / CDP 平台。

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

平台内部字段必须在具体 Platform Hook 或 Legacy Adapter 内完成 Normalize。

所有执行模型最终必须把消息来源统一为：

```text
customer
human
automation
system
unknown
```

Page Hook 平台根据官方 Runtime 信号和 `OutboundCorrelation` 判断。

WeChat / WeWork 优先复用 Legacy 已有的真实信号，例如：

```text
isHumanOutgoingMessage
consumeAutomatedOutbound
autoGenerated
```

证据不足时必须输出：

```text
unknown
```

不得猜测为 `human`。

原始数据可以放：

```text
raw
```

但业务层不得依赖平台 raw 字段。

---

# 19. Product Contract

只有声明 Product Capability 的平台才输出统一 HookProduct。

`products.list` 默认语义：

> 返回当前店铺在售商品。

具体平台如何识别“在售”，属于平台 Hook 的内部实现。

不得让宿主根据平台 status 字段判断。

---

# 20. Order Contract

只有声明 Order Capability 的平台才输出统一 HookOrder。

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

本节只适用于声明 Order Capability 的平台。对于这些平台，订单是核心能力。

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

上层最终统一通过：

```ts
transport.subscribe(listener)
```

监听。Page Hook Transport 在内部映射 `HookSession.subscribe(listener)`；Legacy / Native Transport 映射现有事件源。

---

# 23. Event Performance

不要让每个平台 Client 自己随意创建大量：

```ts
setInterval(...)
```

事件调度由对应执行模型的 Transport / Host 负责。Page Hook 使用 HookHost / Runtime；Legacy / Native Transport 复用并约束现有事件源的生命周期。

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

本节只适用于声明 Product Capability 的 Page / CDP 平台。

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

Page Hook Foundation 的 FakeHook 已经完成，并用于验证 Page Hook Protocol：

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

未来实现 `HookTransport` 后，必须先增加 Fake Native / Legacy Transport，再迁移 WeChat Legacy Adapter。当前 Phase 不提前实现。

---

# 26. Contract Tests

所有正式平台必须通过与其声明 Capability 和执行模型匹配的统一 Contract Test。不得要求 Legacy / Native Transport 通过 Page、Manifest 路由、Worker 或 CDP 生命周期测试。

Page Hook 平台至少测试：

* Manifest
* Capability
* Operation Page Routing
* Runtime install
* Runtime dispose
* start / stop
* 重复 stop
* 店铺隔离
* Persistent Page 创建、复用和 Session 生命周期
* Persistent Page 不被 Worker idle 回收
* Persistent Page 事件 drain / push
* Persistent Runtime refresh 和 Challenge Recovery
* Session dispose 关闭 Persistent Page
* Worker 创建
* Worker 回收
* Message DTO
* Product DTO
* Order DTO
* order.created 去重
* order.updated 去重
* Challenge Recovery
* Runtime Failure Isolation

Legacy / Native Transport 至少测试：

* start / stop
* 重复 stop
* invoke Result / Error mapping
* Message DTO normalize
* Event normalize 与取消订阅
* origin 映射
* Capability 映射
* Lifecycle mapping
* 实例隔离与失败隔离

---

# 27. Platform Development Order

严格：

```text
Hook Foundation
↓
Douyin
↓
Douyin 多账号 / 订单 / Handoff 真实验收
↓
HookTransport 抽象
↓
Fake Native / Legacy Transport
↓
WeChat Legacy Adapter 验证
↓
Aichat React PlatformRuntime 对接
↓
其他 Page Hook 平台
↓
WeWork / Qianniu Legacy Adapter
```

当前仍处于：

```text
Douyin 最终真实验收
```

Douyin 没有完成最终真实验收前，禁止提前实现 `HookTransport`、迁移 WeChat / WeWork / Qianniu、开始 React 对接或推进其他 Page Hook 平台。

---

# 28. Legacy Hook

旧 Hook 代码必须先通过 Branch 或 Git Tag 保存。

WeChat、WeWork、Qianniu 迁移遵循：

```text
Legacy source
尽量保持不变
↓
Adapter / Transport
↓
统一 Contract
```

Adapter / Transport 负责：

* 参数转换
* Message DTO normalize
* Event normalize
* Error mapping
* Lifecycle mapping
* origin 映射
* Capability 映射

不要为了适配统一协议大量修改成熟 Legacy 源代码。

如果 Legacy 代码强依赖旧 Vue 项目环境，优先使用：

```text
shim / adapter
```

不要把旧业务层一起搬进来。

Page Hook 平台可以把旧 Hook 作为：

* Runtime 探索参考
* 已验证调用方式参考
* 字段参考
* 测试参考

Page Hook 不复制旧架构；Legacy / Native / Service 平台则优先复用已经成熟且符合实际运行环境的底层实现。

---

# 29. Development Workflow

每次开发之前：

1. 阅读 AGENTS.md
2. 阅读当前 Phase
3. 阅读已有代码
4. 阅读 Legacy Hook 对应能力
5. 判断属于 PlatformRuntime、Transport、Adapter、Page Hook SDK / Host 或具体平台哪一层
6. 明确修改哪些文件
7. 再编码

---

# 30. Current Phase Rule

当前 Phase 是：

```text
Douyin 最终真实验收
```

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
保持统一 Platform / Hook Transport Contract 与真实执行模型边界
```

发生冲突：

优先保持统一上层 Contract 与正确的执行模型边界。

不要为了快速支持抖店而在 HookHost / hook-sdk 中加入抖店特例。

---

# 34. Page Hook Foundation Freeze

当前已经完成的：

```text
Hook SDK
HookHost
HookSession
PersistentPageManager
WorkerScheduler
PageHookRuntime
Douyin Hook
```

Page Hook Foundation 的 Session 页面生命周期已经明确为：

```text
HookSession
├─ primaryPage
├─ persistentPages  → PersistentPageManager
└─ workerPages      → WorkerPageManager / WorkerScheduler
```

`persistent` 是正式的 `HookPageDefinition.kind`，语义为 lazy create、Session lifetime、no idle recycle；它不是 Electron compatibility shell，也不是把 Worker 页面永久驻留的变通方案。当前 Douyin `orders` 页面使用该模型接收官方通知 Runtime。

继续视为 Page Hook Foundation。

未来增加 `HookTransport` 时，应当在 Page Hook Foundation 之上向上抽象：

```text
PlatformRuntime
↓
Platform Adapter
↓
HookTransport
↓
PageHookTransport
↓
现有 HookSession / HookHost
```

不得为了容纳 Legacy / Native / Service 平台推翻现有 HookHost，也不得把 HookHost 扩展成所有平台的统一宿主。

---

## 35. Douyin / Doudian Naming Rule

Douyin 正式实现目录：

```text
packages/douyin-hook
```

Doudian 属于 Legacy 名称，不得作为新实现目标。

除历史文档说明外，新代码、新测试、新脚本禁止新增 `doudian` 命名。

# Real Verification Environment

本章是 Page Hook 真实验收的项目级硬规则。Page Hook 的正式生产运行环境是 Electron，不得用外部浏览器替代 Electron 验收。

## 1. Default Verification Environment

Page Hook 的正式真实验收环境必须是 Electron `BrowserWindow` / `WebContents`，不是系统浏览器。

正式链路：

```text
Electron Main
↓
HookHost
↓
HookSession
↓
ElectronHookPageFactory
↓
BrowserWindow / WebContents
↓
CDP / executeJavaScript
↓
window.__PLATFORM_HOOK__
↓
平台官方 Runtime
```

只要任务涉及真实登录态、Cookie / Session、partition、`PageHookRuntime`、`HookSession`、`HookHost`、`BrowserWindow`、`WebContents`、CDP、Challenge Recovery、Runtime Store、EventEmitter、Notification Runtime、商品 / 订单 Runtime、消息监听、真实订单验证、真实通知验证或真实页面 Runtime 探索，默认都必须在项目自己的 Electron 环境中验证。

## 2. Browser Rule

除非用户明确说“用浏览器验证”“用 Chrome 验证”或“用 browser-session”，否则禁止用以下外部环境替代 Electron 验收：

* `browser-session`
* 系统 Chrome
* Safari
* 独立 Chromium
* Playwright 独立 browser profile
* 外部浏览器 Cookie / Profile

外部浏览器实验只能辅助探索，不能作为正式验收结论。如果 Chrome PASS 但 Electron FAIL，最终仍视为 Electron FAIL，必须继续排查 Electron 环境。

## 3. Partition Rule

同一个 Shop `HookSession` 的以下页面必须使用同一个 Electron partition：

```text
primary
persistent auxiliary pages
worker pages
```

不同店铺必须使用不同 partition。禁止通过复制系统浏览器 Cookie / Profile 来模拟正式登录态。

## 4. Runtime Inspection Rule

探索页面 Runtime 时优先使用：

```text
Electron WebContents
↓
executeJavaScript / CDP
↓
read-only inspection
```

允许检查 window runtime、store、event emitter、官方 SDK、notification object 和 network metadata；不要默认启动系统浏览器。

## 5. Douyin Verification Rule

Douyin 的真实订单 / 通知验收必须在 Electron 中完成：

```text
Electron persistent auxiliary page
↓
fxg.jinritemai.com
↓
官方 Notification Runtime
↓
msgItem.ext_info
↓
orderId
↓
authoritative order query
```

已确认底层存在：

```text
wss://frontier.snssdk.com/ws/v2
/b/a/api/v1/reach/notice/alert
/b/a/api/v1/reach/list
```

生产代码禁止自行执行：

```ts
new WebSocket('wss://frontier.snssdk.com/ws/v2')
```

必须复用 Electron 页面里官方已经建立好的 Runtime、Store 或 EventEmitter。

## 6. Verification Failure Rule

如果 Codex 尝试 `browser-session` 或系统浏览器，并因为 profile 权限、Chrome 启动失败、浏览器桥接失败或 Cookie / Profile 不可复用而失败，不得把它当成项目真实验收失败。

必须停止浏览器方向，切回：

```text
Electron
BrowserWindow
WebContents
HookSession
```

继续验证。

## 7. Default Decision Rule

以后新会话中，只要任务出现真实验证、真实登录、真实 Runtime、真实通知、真实订单、真实消息、真实页面或 CDP 检查，默认解释为“在 Electron 应用中验证”，而不是“打开外部浏览器验证”。

## 8. Priority Rule

验证优先级固定为：

```text
Electron production runtime
>
FakeHook / automated test
>
external browser experiment
```

外部浏览器只能用于辅助探索，不能替代 Electron production verification。
