import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const kuaishouHook = await readFile(new URL('../packages/kuaishou-hook/src/hook.ts', import.meta.url), 'utf8')
const douyinRuntime = await readFile(new URL('../packages/douyin-hook/src/runtime-source.ts', import.meta.url), 'utf8')
const douyinManifest = await readFile(new URL('../packages/douyin-hook/src/manifest.ts', import.meta.url), 'utf8')
const douyinPackage = JSON.parse(await readFile(new URL('../packages/douyin-hook/package.json', import.meta.url), 'utf8'))
const manager = await readFile(new URL('../src/main/cdp/PlatformManager.ts', import.meta.url), 'utf8')
const platformRegistry = await readFile(new URL('../src/main/platforms/registry.ts', import.meta.url), 'utf8')
const platformRuntimeContracts = await readFile(new URL('../packages/platform-runtime/src/contracts.ts', import.meta.url), 'utf8')
const platformRuntimeRegistry = await readFile(new URL('../packages/platform-runtime/src/platform-registry.ts', import.meta.url), 'utf8')
const platformRuntimeManager = await readFile(new URL('../packages/platform-runtime/src/runtime-manager.ts', import.meta.url), 'utf8')
const pageRuntimeAdapter = await readFile(new URL('../packages/platform-runtime/src/page-hook-adapter.ts', import.meta.url), 'utf8')
const goofishAdapter = await readFile(new URL('../packages/platform-goofish/src/goofish-runtime-adapter.ts', import.meta.url), 'utf8')
const douyinAdapter = await readFile(new URL('../packages/platform-douyin/src/runtime-factory.ts', import.meta.url), 'utf8')
const shopRuntimeManager = await readFile(new URL('../src/main/runtime/ShopRuntimeManager.ts', import.meta.url), 'utf8')
const platformTypes = await readFile(new URL('../src/shared/platform.ts', import.meta.url), 'utf8')
const session = await readFile(new URL('../src/main/cdp/CdpSession.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const renderer = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const viewport = await readFile(new URL('../src/renderer/src/components/PlatformViewport.tsx', import.meta.url), 'utf8')
const hookSdkPackage = JSON.parse(await readFile(new URL('../packages/hook-sdk/package.json', import.meta.url), 'utf8'))
const hookHostPackage = JSON.parse(await readFile(new URL('../packages/hook-host/package.json', import.meta.url), 'utf8'))
const hookTransportPackage = JSON.parse(await readFile(new URL('../packages/hook-transport/package.json', import.meta.url), 'utf8'))
const hookTransportTypes = await readFile(new URL('../packages/hook-transport/src/types.ts', import.meta.url), 'utf8')
const pageHookTransport = await readFile(new URL('../packages/hook-transport/src/page-hook-transport.ts', import.meta.url), 'utf8')
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

test('HookTransport keeps the public contract execution-model-neutral', () => {
  const dependencies = { ...hookTransportPackage.dependencies, ...hookTransportPackage.devDependencies }
  assert.equal(hookTransportPackage.dependencies['@platform-hub/hook-sdk'], 'workspace:*')
  assert.equal(hookTransportPackage.dependencies['@platform-hub/hook-host'], 'workspace:*')
  for (const forbidden of ['electron', 'react', 'vue', '@platform-hub/douyin-hook', '@platform-hub/kuaishou-hook']) {
    assert.equal(dependencies[forbidden], undefined)
  }
  assert.doesNotMatch(hookTransportTypes, /hook-host|electron|react|vue|douyin|kuaishou|goofish|wechat|wework|qianniu/i)
  assert.match(hookTransportTypes, /interface HookTransport/)
  assert.match(hookTransportTypes, /HookEvent/)
  assert.match(hookTransportTypes, /HookResult/)
})

test('PlatformRuntimeAdapter and Registry provide one generic plugin boundary', () => {
  for (const member of ['id', 'transport', 'start()', 'stop()', 'getStatus()', 'attachPrimaryView()', 'detachPrimaryView()', 'dispose()']) {
    assert.ok(platformRuntimeContracts.includes(member), `PlatformRuntimeAdapter missing ${member}`)
  }
  assert.match(platformRuntimeRegistry, /register\(factory: PlatformRuntimeFactory\)/)
  assert.match(platformRuntimeRegistry, /require\(platformId: string\)/)
  assert.doesNotMatch(platformRuntimeRegistry, /douyin|goofish|kuaishou/i)
  assert.match(platformRuntimeManager, /this\.registry\.require\(account\.platform\)/)
  assert.match(platformRuntimeManager, /adapter\.transport\.invoke/)
})

test('ShopRuntimeManager consumes the unified HookTransport contract', () => {
  assert.match(shopRuntimeManager, /import type \{ HookTransport \} from '@platform-hub\/hook-transport'/)
  assert.doesNotMatch(shopRuntimeManager, /ShopTransportLike/)
})

test('PageHookTransport is a thin session adapter without host ownership or platform branches', () => {
  assert.match(pageHookTransport, /from '@platform-hub\/hook-host'/)
  assert.doesNotMatch(pageHookTransport, /new\s+HookHost/)
  assert.doesNotMatch(pageHookTransport, /platform\s*===|switch\s*\(\s*platform|douyin|kuaishou|goofish|wechat|wework|qianniu/i)
  assert.match(pageHookTransport, /disposeSession/)
})

test('正式 Douyin Hook 仅将 DOM 投影限制在会话原生 attention，且不依赖 Legacy', () => {
  assert.doesNotMatch(douyinRuntime, /\.click\(|dispatchEvent|XMLHttpRequest|WebSocket/)
  assert.match(douyinRuntime, /PRODUCT_LIST_PATH\s*=\s*['"]\/product\/tproduct\/list/)
  assert.match(douyinRuntime, /credentials:\s*['"]include['"]/)
  assert.equal(douyinPackage.dependencies['@platform-hub/hook-sdk'], 'workspace:*')
  assert.equal(douyinPackage.dependencies['@platform-hub/hook-host'], 'workspace:*')
  assert.match(douyinRuntime, /__PLATFORM_HOOK__/)
  assert.match(douyinRuntime, /conversationsInfo/)
  assert.match(douyinRuntime, /_message\$/)
  assert.match(douyinRuntime, /customRequestUpload/)
  assert.match(douyinRuntime, /conversation\.attention\.set/)
  assert.match(douyinRuntime, /MutationObserver/)
  assert.equal((douyinRuntime.match(/querySelectorAll/g) || []).length, 1)
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
  assert.match(renderer, /upsertPlatformMessage\(current \|\| \[\], message\)/)
})

test('平台操作遇到登录状态时会等待并重试', () => {
  assert.match(manager, /LOGIN_REQUIRED/)
  assert.match(manager, /waitForLogin/)
  assert.match(manager, /runtime\.transport\.invoke<T>/)
  assert.match(pageRuntimeAdapter, /runtime\.invoke\(method, \.\.\.args\)/)
})

test('商品官方验证会显示并聚焦当前店铺的商品页', () => {
  assert.match(manager, /result\.error\.code === 'CHALLENGE_REQUIRED'/)
  assert.match(manager, /runtime\.showOperationPage\?\.\(operation\)/)
  assert.match(pageRuntimeAdapter, /showRuntimePageFor\(methodFor\(operation\)\)/)
  assert.match(session, /clearRuntimeWindowTimer\(route\.id\)/)
  assert.match(session, /target\.focus\(\)/)
})

test('已登录但未暴露能力时不会误进入登录等待', () => {
  const notReadyBranch = manager.match(/else if \(result\.error\.code === 'RUNTIME_NOT_READY'\)[\s\S]*?\n    \}/)?.[0] || ''
  assert.match(notReadyBranch, /showOperationPage/)
  assert.doesNotMatch(notReadyBranch, /waitForLogin/)
})

test('登录成功后自动进入 manifest 声明的消息接待页', () => {
  assert.match(session, /ensurePrimaryRuntimePage/)
  assert.match(session, /loadURL\(this\.options\.hook\.url\)/)
  assert.match(session, /登录成功，正在进入消息接待页/)
})

test('平台可通过 manifest 声明官方登录页并保持同一账号分区', () => {
  assert.match(session, /setWindowOpenHandler/)
  assert.match(session, /loginUrlFor/)
  assert.match(session, /contents\?\.loadURL\(loginUrl\)/)
  assert.match(session, /waitForLogin\(timeoutMs = 15 \* 60_000, method\?: string\)/)
  assert.match(pageRuntimeAdapter, /waitForLogin\(undefined, methodFor\(operation\)\)/)
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
  assert.match(main, /PLATFORM_HUB_DISABLE_GPU/)
  assert.doesNotMatch(main, /disableHardwareAcceleration\(\)\s*\n\s*}\s*\nif \(!app\.isPackaged\)/)
})

test('主工作台只展示 Hook primary WebContentsView，不创建 Renderer webview', () => {
  assert.match(session, /WebContentsView/)
  assert.match(session, /attachPrimaryView\(\)/)
  assert.match(session, /detachPrimaryView\(\)/)
  assert.match(session, /primaryAttached/)
  assert.match(session, /contentView\.addChildView\(view\)/)
  assert.match(session, /contentView\.removeChildView\(view\)/)
  assert.match(manager, /runtimeManager\.detachPrimaryView\(other\.id\)/)
  assert.match(manager, /runtime\.attachPrimaryView\(\)/)
  assert.match(pageRuntimeAdapter, /runtime\.setPrimaryBounds\(bounds\)/)
  assert.match(session, /if \(this\.primaryAttached && this\.primaryView/)
  assert.match(main, /viewport:bounds/)
  assert.doesNotMatch(viewport, /<webview/)
  assert.doesNotMatch(viewport, /partition=\{props\.account\.partition\}/)
})

test('主工作台切换只移动 active View，不 reload 或销毁后台店铺 WebContents', () => {
  const openBody = manager.match(/async open\(accountId: string\): Promise<PlatformAccount> \{([\s\S]*?)\n  \}\n\n  async connect/)?.[1] || ''
  assert.match(openBody, /runtimeManager\.detachPrimaryView\(other\.id\)/)
  assert.match(openBody, /await runtime\.attachPrimaryView\(\)/)
  assert.doesNotMatch(openBody, /loadURL\(|webContents\.(?:close|destroy)\(/)
  const detachBody = session.match(/detachPrimaryView\(\): void \{([\s\S]*?)\n  \}\n\n  setPrimaryBounds/)?.[1] || ''
  assert.match(detachBody, /removeChildView\(view\)/)
  assert.doesNotMatch(detachBody, /webContents\.close\(\)/)
  assert.match(manager, /runtimeManager\.detachPrimaryView\(other\.id\)/)
  assert.doesNotMatch(manager, /webContents\.(?:close|destroy)\(/)
})

test('PlatformManager 仅依赖 Registry/Adapter；Goofish 实现封装在独立包', () => {
  assert.doesNotMatch(manager, /@idle-fish\/goofish-messaging|GoofishMessagingClient|GoofishTransport|goofishViews|ensureGoofish/)
  assert.match(manager, /PlatformRuntimeManager/)
  const addAccountBody = manager.match(/async addAccount\(input: \{[\s\S]*?\n  \}\n\n  async removeAccount/)?.[0] || ''
  assert.match(addAccountBody, /this\.registry\.require\(input\.platform\)/)
  assert.doesNotMatch(addAccountBody, /platform\s*===|switch\s*\(/)
  assert.doesNotMatch(manager, /platform\s*===|switch\s*\(\s*account\.platform/)
  assert.match(goofishAdapter, /executionModel:\s*'native'/)
  assert.match(goofishAdapter, /new GoofishMessagingClient\(/)
  assert.match(goofishAdapter, /new GoofishTransport\(/)
  assert.match(goofishAdapter, /new WebContentsView\(/)
  assert.match(goofishAdapter, /attachEmbeddedWebContents\(/)
  assert.match(douyinAdapter, /class DouyinRuntimeAdapter extends PageHookRuntimeAdapter/)
  assert.match(douyinAdapter, /createCdpSession\(account, context/)
  assert.match(platformRegistry, /createGoofishRuntimeFactory/)
  assert.match(main, /await manager\.attachMainWindow\(mainWindow\)/)
  assert.match(main, /manager\.setAccountOnline\(id, online\)/)
})

test('公共 PlatformAccount 不泄漏平台私有 Adapter 元数据', () => {
  const accountInterface = platformTypes.match(/export interface PlatformAccount \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.ok(accountInterface)
  assert.doesNotMatch(accountInterface, /adapterMetadata|goofishClientAccountId/)
  assert.match(platformRuntimeContracts, /adapterMetadata\?: Record<string, unknown>/)
  const publicAccountBody = manager.match(/function publicAccount\([\s\S]*?\nfunction applyStatus/)?.[0] || ''
  assert.doesNotMatch(publicAccountBody, /adapterMetadata|goofishClientAccountId/)
})

test('官方工作台占据主区域，调试信息默认折叠且页面不随 document 滚动', async () => {
  const styles = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  assert.match(styles, /html, body, #root\s*\{[^}]*height:\s*100%/s)
  assert.match(styles, /body\s*\{[^}]*overflow:\s*hidden/s)
  assert.match(styles, /grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)\s+250px/)
  assert.match(styles, /\.platform-viewport\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s)
  assert.match(styles, /\.platform-frame-body\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/s)
  assert.doesNotMatch(styles, /height:\s*clamp\(380px,\s*58vh,\s*640px\)/)
  assert.match(viewport, /<details className="developer-drawer">/)
})

test('工作台认证完成后自动加载会话并接收未知会话消息', () => {
  assert.match(renderer, /if \(event\.type === 'message'\)/)
  assert.match(renderer, /setSessionsByAccount/)
  assert.match(renderer, /item\.id === message\.sessionId/)
})

test('账号状态串行原子保存并可从有效备份恢复', () => {
  assert.match(manager, /stateBackupPath/)
  assert.match(manager, /saveQueue/)
  assert.match(manager, /process\.pid\}\.tmp/)
  assert.match(manager, /rename\(temporaryPath, this\.statePath\)/)
  assert.match(manager, /readState\(this\.stateBackupPath\)/)
})
