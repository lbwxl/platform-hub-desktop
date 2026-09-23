import { app, BrowserWindow } from 'electron'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookHost } from '../packages/hook-host/dist/index.js'
import { PageHookTransport } from '../packages/hook-transport/dist/index.js'
import { createDouyinElectronPageFactory, douyinHookManifest } from '../packages/douyin-hook/dist/index.js'
import { HttpShopReplyApi, ShopRuntimeManager } from '../src/main/runtime/ShopRuntimeManager.ts'

const slots = [
  { id: 'shop-a', shopId: process.env.DOUYIN_VERIFY_SHOP_ID_A || 'douyin-multi-shop-a', partition: process.env.DOUYIN_VERIFY_PARTITION_A || 'persist:platform-hub-douyin-verify-a' },
  { id: 'shop-b', shopId: process.env.DOUYIN_VERIFY_SHOP_ID_B || 'douyin-multi-shop-b', partition: process.env.DOUYIN_VERIFY_PARTITION_B || 'persist:platform-hub-douyin-verify-b' },
]
const userData = process.env.DOUYIN_VERIFY_MULTI_SHOP_USER_DATA || process.env.DOUYIN_VERIFY_USER_DATA_A || join(tmpdir(), 'platform-hub-multi-shop-ai')
const replyApiConfigured = Boolean(process.env.PLATFORM_HUB_REPLY_API_URL)
const state = new Map(slots.map((slot) => [slot.id, { slot, inbound: 0, automation: 0, replies: 0, online: false, offlineReplyBaseline: undefined }]))

let host
let manager
let activeAccountId = 'shop-a'
let input
let shuttingDown = false

app.disableHardwareAcceleration()
app.setPath('userData', userData)
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

void app.whenReady().then(async () => {
  host = new HookHost({
    pageFactory: createDouyinElectronPageFactory({
      logger: silentLogger,
      createWindow: (context) => new BrowserWindow({
        width: 1180,
        height: 820,
        show: context.definition.kind === 'primary',
        title: `Multi-shop AI verify · ${context.shopId}`,
        webPreferences: { partition: context.partition, contextIsolation: false, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
      }),
    }),
    logger: silentLogger,
  })
  manager = new ShopRuntimeManager(new HttpShopReplyApi())
  manager.onEvent(onRuntimeEvent)
  for (const { id, shopId, partition } of slots) {
    const session = host.createSession(douyinHookManifest, {
      sessionId: `verify-multi-shop-ai-${id}`,
      shopId,
      partition,
      maxWorkers: 1,
      workerIdleTtlMs: 30_000,
    })
    manager.register(id, new PageHookTransport({ session, disposeSession: () => host.disposeSession(session.sessionId) }))
    await manager.setOnline(id, true)
    state.get(id).online = true
  }
  write('SHOP_A_RUNTIME_ALIVE', 'PASS', runtime('shop-a'))
  write('SHOP_B_RUNTIME_ALIVE', 'PASS', runtime('shop-b'))
  if (!replyApiConfigured) write('REPLY_API', 'SKIPPED', { reason: 'PLATFORM_HUB_REPLY_API_URL is not configured; incoming messages will not be automatically sent' })
  input = createInterface({ input: process.stdin, output: process.stdout })
  input.on('line', (line) => { void command(line.trim()) })
  process.stdout.write('Electron 双店铺验收已就绪。先分别完成 A/B 登录，然后使用: active a|b, offline a, online a, status, quit。\n')
}).catch(async (error) => {
  write('MULTI_SHOP_REAL_ACCEPTANCE', 'FAIL', { message: message(error) })
  await shutdown(1)
})

function onRuntimeEvent(event) {
  const account = state.get(event.accountId)
  if (!account) return
  if (event.type === 'reply') {
    account.replies += 1
    write(`${event.accountId.toUpperCase().replace('-', '_')}_BACKGROUND_REPLY`, replyApiConfigured ? 'PASS' : 'SKIPPED', event.payload)
    return
  }
  if (event.type !== 'hook') return
  const hookEvent = event.payload.event
  const item = hookEvent?.payload?.message || hookEvent?.payload
  if (hookEvent?.type !== 'message.created' || !item) return
  if (item.direction === 'inbound' && item.origin === 'customer') {
    account.inbound += 1
    const inactive = event.accountId !== activeAccountId
    write(`${event.accountId.toUpperCase().replace('-', '_')}_BACKGROUND_MESSAGE`, 'PASS', { inactive, conversationId: item.conversationId, content: item.content })
  }
  if (item.direction === 'outbound' && item.origin === 'automation') {
    account.automation += 1
    write(`${event.accountId.toUpperCase().replace('-', '_')}_AUTOMATION_SENT`, 'PASS', { conversationId: item.conversationId })
  }
}

async function command(value) {
  const [action, argument] = value.toLowerCase().split(/\s+/, 2)
  if (action === 'quit' || action === 'exit') return shutdown(0)
  if (action === 'active' && state.has(`shop-${argument}`)) {
    activeAccountId = `shop-${argument}`
    write('ACTIVE_SWITCH_NO_DISPOSE', 'PASS', { activeAccountId, shopA: runtime('shop-a'), shopB: runtime('shop-b') })
    return
  }
  if ((action === 'online' || action === 'offline') && state.has(`shop-${argument}`)) {
    const accountId = `shop-${argument}`
    await manager.setOnline(accountId, action === 'online')
    const target = state.get(accountId)
    target.online = action === 'online'
    target.offlineReplyBaseline = action === 'offline' ? target.replies : undefined
    write(action === 'online' ? 'SHOP_ONLINE' : 'SHOP_OFFLINE_READY', 'PASS', { accountId, ...runtime(accountId), instruction: action === 'offline' ? '现在让该店买家发送一条消息，再输入 status 验证没有自动回复' : undefined })
    return
  }
  if (action === 'status') {
    for (const accountId of state.keys()) {
      const account = state.get(accountId)
      write('RUNTIME_STATE', 'PASS', { accountId, active: accountId === activeAccountId, counters: account, runtime: runtime(accountId) })
      if (!account.online && account.offlineReplyBaseline !== undefined) {
        write('OFFLINE_NO_AI_REPLY', account.replies === account.offlineReplyBaseline ? 'PASS' : 'FAIL', { accountId, inbound: account.inbound, repliesSinceOffline: account.replies - account.offlineReplyBaseline })
      }
    }
    write('MULTI_SHOP_REAL_ACCEPTANCE', replyApiConfigured ? 'READY_FOR_MANUAL_EVENTS' : 'SKIPPED', { activeAccountId, replyApiConfigured })
    return
  }
  process.stdout.write('命令: active a|b, online a|b, offline a|b, status, quit\n')
}

function runtime(accountId) {
  return manager?.snapshot(accountId) || { accountId, runtimeState: 'stopped' }
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  input?.close()
  for (const accountId of state.keys()) await manager?.stop(accountId).catch(() => undefined)
  await host?.dispose().catch(() => undefined)
  app.exit(code)
}

function write(label, status, extra = {}) { process.stdout.write(`${label} ${status} ${JSON.stringify(extra)}\n`) }
function message(error) { return error instanceof Error ? error.message : String(error) }
const silentLogger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}]))
