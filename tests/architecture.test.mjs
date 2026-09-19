import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const hook = await readFile(new URL('../packages/doudian-hook/src/hook.ts', import.meta.url), 'utf8')
const client = await readFile(new URL('../packages/doudian-hook/src/client.ts', import.meta.url), 'utf8')
const apiDoc = await readFile(new URL('../packages/doudian-hook/API.md', import.meta.url), 'utf8')
const kuaishouHook = await readFile(new URL('../packages/kuaishou-hook/src/hook.ts', import.meta.url), 'utf8')
const manager = await readFile(new URL('../src/main/cdp/PlatformManager.ts', import.meta.url), 'utf8')
const session = await readFile(new URL('../src/main/cdp/CdpSession.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const renderer = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')

test('抖店 hook 不访问或操作 DOM', () => {
  assert.doesNotMatch(hook, /document\.|querySelector|MutationObserver|\.click\(|dispatchEvent/)
})

test('快手 hook 仅使用 CDP window runtime，不操作 DOM 或拦截网络', () => {
  assert.doesNotMatch(kuaishouHook, /document\.|querySelector|MutationObserver|\.click\(|dispatchEvent|fetch\(|XMLHttpRequest|WebSocket/)
  assert.match(kuaishouHook, /Object\.getOwnPropertyNames\(scope\.value\)/)
  assert.match(kuaishouHook, /__chat_sdk/)
  assert.match(kuaishouHook, /currentSessionMessageListStore/)
  assert.match(kuaishouHook, /sendMessage/)
  assert.match(kuaishouHook, /collectProducts/)
})

test('快手 hook 有界发现并在升级或释放时清理事件资源', () => {
  assert.match(kuaishouHook, /output\.length < 1200/)
  assert.match(kuaishouHook, /slice\(0, 160\)/)
  assert.match(kuaishouHook, /existing\?\.dispose\?\.\(\)/)
  assert.match(kuaishouHook, /clearInterval\(pollTimer\)/)
  assert.match(kuaishouHook, /unsubscribe/)
  assert.match(kuaishouHook, /owner\.off\(eventName, handler\)/)
  assert.match(kuaishouHook, /function bindNativeMessages\(\)/)
  assert.match(kuaishouHook, /pollMessages\(\)\s+bindNativeMessages\(\)/)
  assert.match(kuaishouHook, /if \(subscriptions\.length && pollTimer\)/)
  assert.match(kuaishouHook, /waterlines/)
})

test('快手 hook 使用官方 SDK 会话路径和消息事件', () => {
  assert.match(kuaishouHook, /sessionModel\?\.sessionAllModel\?\.allSessionMap/)
  assert.match(kuaishouHook, /chatWithTarget\(\{ targetSession: session \}\)/)
  assert.match(kuaishouHook, /system\.session\.newMessageFromBuyer/)
  assert.match(kuaishouHook, /esImSdk, 'messagesUpdate'/)
})

test('快手订单事件有历史水位线、状态去重和显式同步结果', () => {
  assert.match(kuaishouHook, /seenOrderKeys/)
  assert.match(kuaishouHook, /message\.order\.orderId, message\.order\.status \|\| '', message\.id/)
  assert.match(kuaishouHook, /push\('order'/)
  assert.match(kuaishouHook, /async function syncOrders/)
  assert.match(kuaishouHook, /authoritative:/)
})

test('快手订单监听使用有界 LRU、TTL 和单批次调度', () => {
  assert.match(kuaishouHook, /ORDER_WATCH_MAX = 50/)
  assert.match(kuaishouHook, /ORDER_WATCH_TTL_MS = 30 \* 60 \* 1000/)
  assert.match(kuaishouHook, /ORDER_ACTIVE_INTERVAL_MS = 5 \* 1000/)
  assert.match(kuaishouHook, /ORDER_IDLE_INTERVAL_MS = 30 \* 1000/)
  assert.match(kuaishouHook, /slice\(0, ORDER_POLL_BATCH_SIZE\)/)
  assert.match(kuaishouHook, /removeOrderWatch/)
  assert.match(kuaishouHook, /touchOrderWatch/)
})

test('快手自发文本使用有界缓存回填发送瞬间的空正文事件', () => {
  assert.match(kuaishouHook, /pendingSentTexts/)
  assert.match(kuaishouHook, /SENT_TEXT_TTL_MS = 30 \* 1000/)
  assert.match(kuaishouHook, /SENT_TEXT_MAX = 100/)
  assert.match(kuaishouHook, /pendingTextForMessage/)
  assert.match(kuaishouHook, /pendingSentTexts\.clear\(\)/)
  assert.match(renderer, /upsertPlatformMessage\(messages\.value, message\)/)
})

test('抖店 hook 只从 window runtime 解析平台能力', () => {
  assert.match(hook, /Object\.getOwnPropertyNames\(window\)/)
  assert.match(hook, /collectProducts/)
  assert.match(hook, /subscribeMessages/)
  assert.match(hook, /sendMessage/)
  assert.match(hook, /listMessages/)
  assert.match(hook, /customRequestUpload/)
  assert.match(hook, /productFromMessage/)
  assert.match(hook, /orderFromMessage/)
  assert.match(hook, /jsonIntegerString/)
  assert.match(hook, /cardSourceScene/)
  assert.match(hook, /static_data/)
})

test('抖店 hook 升级时释放旧监听器', () => {
  assert.match(hook, /existing\?\.dispose\?\.\(\)/)
  assert.match(hook, /HOOK_VERSION/)
})

test('抖店商品列表等待官方缓存并兼容商品与货品列表键', () => {
  assert.match(hook, /isProductList/)
  assert.match(hook, /product\|goods/)
  assert.match(hook, /waitForCachedProductRows/)
  assert.match(hook, /isProductRuntimePage/)
})

test('抖店消息轮询只在官方订阅流不可用时回退', () => {
  assert.match(hook, /subscriptions\.length \? null : setInterval/)
})

test('抖店订单事件有历史水位线、状态去重和显式同步结果', () => {
  assert.match(hook, /seenOrderKeys/)
  assert.match(hook, /function orderStateKey\(order\)/)
  assert.match(hook, /ORDER_ACTIVE_INTERVAL_MS = 5 \* 1000/)
  assert.match(hook, /async function pollOrderChanges\(\)/)
  assert.match(hook, /source: 'platform-runtime'/)
  assert.match(hook, /const emittedOrderKeys = new Set\(\)/)
  assert.match(hook, /emitOrderState/)
  assert.match(hook, /push\('order'/)
  assert.match(hook, /async function syncOrders/)
  assert.match(hook, /authoritative:/)
  assert.match(session, /item\.type === 'order' \? 'order'/)
})

test('抖店包只暴露订单事件，由宿主决定是否入库', () => {
  assert.match(client, /subscribeOrders\(/)
  assert.match(client, /event\.type === 'order'/)
  assert.match(apiDoc, /不保存订单/)
  assert.match(apiDoc, /orderRepository\.upsert/)
  assert.match(apiDoc, /subscribeOrders\(listener/)
})

test('平台操作遇到登录状态时会等待并重试', () => {
  assert.match(manager, /LOGIN_REQUIRED/)
  assert.match(manager, /waitForLogin/)
  assert.match(manager, /return cdp\.invoke<T>\(method/)
})

test('已登录但未暴露能力时不会误进入登录等待', () => {
  assert.match(manager, /await cdp\.showRuntimePageFor\(method\)/)
  assert.doesNotMatch(manager, /RUNTIME_NOT_READY' && cdp\.getStatus\(\)\.authenticated\) return result/)
})

test('登录成功后自动进入 manifest 声明的消息接待页', () => {
  assert.match(session, /ensurePrimaryRuntimePage/)
  assert.match(session, /loadURL\(this\.options\.hook\.url\)/)
  assert.match(session, /登录成功，正在进入消息接待页/)
})

test('平台可通过 manifest 声明官方登录页并保持同一账号分区', () => {
  assert.match(session, /setWindowOpenHandler/)
  assert.match(session, /loginUrlFor/)
  assert.match(session, /this\.window\.loadURL\(loginUrl\)/)
  assert.match(session, /waitForLogin\(timeoutMs = 15 \* 60_000, method\?: string\)/)
  assert.match(manager, /waitForLogin\(undefined, method\)/)
})

test('伴随页官方登录重定向不会被 ERR_ABORTED 误判为加载失败', () => {
  assert.match(session, /loadRuntimeUrl/)
  assert.match(session, /ERR_ABORTED/)
  assert.match(session, /currentUrl !== 'about:blank'/)
})

test('多账号 CDP 心跳合并调用、阻止重叠并回收伴随页', () => {
  assert.match(session, /AUTH_POLL_INTERVAL_MS = 15_000/)
  assert.match(session, /UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS = 2_000/)
  assert.match(session, /pollInFlight/)
  assert.match(session, /pollGeneration/)
  assert.match(session, /runtimePollExpression/)
  assert.match(session, /events: await safely\('drainEvents', \[\]\)/)
  assert.match(session, /RUNTIME_PAGE_IDLE_MS = 2 \* 60_000/)
  assert.match(session, /scheduleRuntimeWindowClose/)
  assert.match(session, /this\.stopRuntimePolling\(\)\s+this\.closeRuntimeWindows\(\)/)
  assert.match(main, /PLATFORM_HUB_ENABLE_GPU/)
})

test('工作台认证完成后自动加载会话并接收未知会话消息', () => {
  assert.match(renderer, /if \(!wasAuthenticated && status\.value\.authenticated\) void refreshSessions\(false\)/)
  assert.match(renderer, /sessions\.value = \[session, \.\.\.sessions\.value\]/)
})

test('账号状态串行原子保存并可从有效备份恢复', () => {
  assert.match(manager, /stateBackupPath/)
  assert.match(manager, /saveQueue/)
  assert.match(manager, /process\.pid\}\.tmp/)
  assert.match(manager, /rename\(temporaryPath, this\.statePath\)/)
  assert.match(manager, /readState\(this\.stateBackupPath\)/)
})
