import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const kuaishouHook = await readFile(new URL('../packages/kuaishou-hook/src/hook.ts', import.meta.url), 'utf8')
const douyinRuntime = await readFile(new URL('../packages/douyin-hook/src/runtime-source.ts', import.meta.url), 'utf8')
const douyinManifest = await readFile(new URL('../packages/douyin-hook/src/manifest.ts', import.meta.url), 'utf8')
const douyinPackage = JSON.parse(await readFile(new URL('../packages/douyin-hook/package.json', import.meta.url), 'utf8'))
const manager = await readFile(new URL('../src/main/cdp/PlatformManager.ts', import.meta.url), 'utf8')
const session = await readFile(new URL('../src/main/cdp/CdpSession.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const renderer = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
const hookSdkPackage = JSON.parse(await readFile(new URL('../packages/hook-sdk/package.json', import.meta.url), 'utf8'))
const hookHostPackage = JSON.parse(await readFile(new URL('../packages/hook-host/package.json', import.meta.url), 'utf8'))
const foundationSources = await Promise.all([
  '../packages/hook-sdk/src/protocol/index.ts',
  '../packages/hook-sdk/src/contracts/index.ts',
  '../packages/hook-sdk/src/outbound/index.ts',
  '../packages/hook-host/src/index.ts',
  '../packages/hook-host/src/session/hook-session.ts',
  '../packages/hook-host/src/pages/worker-page-manager.ts',
  '../packages/hook-host/src/scheduler/worker-scheduler.ts',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))

test('Hook SDK stays platform and framework independent', () => {
  const dependencies = { ...hookSdkPackage.dependencies, ...hookSdkPackage.devDependencies }
  for (const forbidden of ['electron', 'react', 'vue', '@platform-hub/douyin-hook', '@platform-hub/kuaishou-hook']) {
    assert.equal(dependencies[forbidden], undefined)
  }
  assert.doesNotMatch(foundationSources.slice(0, 3).join('\n'), /from ['"](?:electron|react|vue)/)
})

test('Hook foundation contains no platform branches or direct console logging', () => {
  const source = foundationSources.join('\n')
  assert.doesNotMatch(source, /platform\s*===|switch\s*\(\s*platform|douyin|kuaishou|pinduoduo|goofish/)
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error|debug)/)
  assert.equal(hookHostPackage.dependencies['@platform-hub/hook-sdk'], 'workspace:*')
})

test('正式 Douyin Hook 只使用 window runtime 且不依赖 Legacy', () => {
  assert.doesNotMatch(douyinRuntime, /document\.|querySelector|MutationObserver|\.click\(|dispatchEvent|fetch\(|XMLHttpRequest|WebSocket/)
  assert.equal(douyinPackage.dependencies['@platform-hub/hook-sdk'], 'workspace:*')
  assert.equal(douyinPackage.dependencies['@platform-hub/hook-host'], 'workspace:*')
  assert.match(douyinRuntime, /__PLATFORM_HOOK__/)
  assert.match(douyinRuntime, /conversationsInfo/)
  assert.match(douyinRuntime, /_message\$/)
  assert.match(douyinRuntime, /customRequestUpload/)
  assert.match(douyinManifest, /handoff\.targets\.list/)
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
