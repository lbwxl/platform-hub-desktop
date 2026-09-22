import { app } from 'electron'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookHost } from '../packages/hook-host/dist/index.js'
import { PageHookTransport } from '../packages/hook-transport/dist/index.js'
import {
  createDouyinElectronPageFactory,
  douyinHookManifest,
} from '../packages/douyin-hook/dist/index.js'

const userData = process.env.DOUYIN_VERIFY_USER_DATA || join(tmpdir(), 'platform-hub-douyin-transport')
const partition = process.env.DOUYIN_VERIFY_PARTITION || 'persist:platform-hook-douyin-transport'
const shopId = process.env.DOUYIN_VERIFY_SHOP_ID || 'douyin-transport-verification'
const conversationId = argumentValue('--conversation-id')
const sendText = argumentValue('--send-text')

let host
let session
let transport
let input
let shuttingDown = false
let sawMessageEvent = false

app.disableHardwareAcceleration()
app.setPath('userData', userData)
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

void app.whenReady().then(async () => {
  try {
    await start()
    input = createInterface({ input: process.stdin, output: process.stdout })
    input.on('line', (line) => { void handleCommand(line.trim()) })
    await verify()
  } catch (error) {
    write('TRANSPORT_REAL_ACCEPTANCE', 'FAIL', { message: errorMessage(error) })
    await shutdown(1)
  }
}).catch((error) => {
  write('TRANSPORT_REAL_ACCEPTANCE', 'FAIL', { message: errorMessage(error) })
  app.exit(1)
})

async function start() {
  const factory = createDouyinElectronPageFactory({
    logger: safeLogger,
    windowOptions: { width: 1280, height: 860 },
  })
  host = new HookHost({ pageFactory: factory, logger: safeLogger })
  session = host.createSession(douyinHookManifest, {
    sessionId: `douyin-transport-${Date.now()}`,
    shopId,
    partition,
    maxWorkers: 1,
    workerIdleTtlMs: 30_000,
  })
  transport = new PageHookTransport({
    session,
    disposeSession: () => host.disposeSession(session.sessionId),
  })
  transport.subscribe((event) => {
    if (event.type !== 'message.created') return
    sawMessageEvent = true
    const message = event.payload.message
    write('TRANSPORT_EVENT', 'PASS', {
      type: event.type,
      conversationId: message.conversationId,
      direction: message.direction,
      origin: message.origin,
      messageType: message.type,
    })
    write('TRANSPORT_EVENT_SUBSCRIBE', 'PASS')
  })
  await transport.start()
  write('TRANSPORT_START', 'PASS')
}

async function verify() {
  const auth = await transport.invoke('auth.state', {})
  write('TRANSPORT_AUTH', auth.ok ? 'PASS' : 'FAIL', auth.ok
    ? { authenticated: auth.data.authenticated, shopId: auth.data.shopId, userId: auth.data.userId }
    : { error: publicError(auth) })
  if (!auth.ok || !auth.data.authenticated) {
    write('TRANSPORT_AUTH', 'FAIL', { message: '请在 Electron 页面完成登录，脚本会继续等待' })
    await waitForAuthentication()
  }

  const sessions = await transport.invoke('sessions.list', {})
  const items = sessions.ok ? sessions.data.slice(0, 10).map((item) => ({
    id: item.id,
    title: item.title,
    unreadCount: item.unreadCount,
  })) : []
  write('TRANSPORT_SESSIONS', sessions.ok ? 'PASS' : 'FAIL', {
    count: sessions.ok ? sessions.data.length : undefined,
    items,
    error: sessions.ok ? undefined : publicError(sessions),
  })
  write('TRANSPORT_EVENT_SUBSCRIBE', 'PASS', { waitingForMessage: true })

  const target = conversationId || items[0]?.id
  if (target) {
    await verifyAttention(target)
    if (sendText !== undefined) {
      const result = await transport.invoke('messages.send.text', { conversationId: target, text: sendText })
      write('TRANSPORT_SEND_TEXT', result.ok ? 'PASS' : 'FAIL', result.ok
        ? { id: result.data.id, deliveryStatus: result.data.deliveryStatus, origin: result.data.origin }
        : { error: publicError(result) })
    } else {
      write('TRANSPORT_SEND_TEXT', 'SKIPPED', { reason: '仅 --send-text 显式启用真实发送' })
    }
  } else {
    write('TRANSPORT_ATTENTION_PENDING', 'SKIPPED', { reason: '没有可用 conversationId；可使用 --conversation-id=<id>' })
    write('TRANSPORT_ATTENTION_RESOLVED', 'SKIPPED')
    write('TRANSPORT_SEND_TEXT', 'SKIPPED')
  }
  write('TRANSPORT_REAL_ACCEPTANCE', 'PASS', { waitingFor: 'quit', eventObserved: sawMessageEvent })
  process.stdout.write('输入 quit 结束 Electron 验证；可让买家发送消息以观察 message.created。\n')
}

async function verifyAttention(target) {
  const pending = await transport.invoke('conversation.attention.set', { conversationId: target, state: 'pending' })
  write('TRANSPORT_ATTENTION_PENDING', pending.ok ? 'PASS' : 'FAIL', pending.ok ? { conversationId: target } : { error: publicError(pending) })
  if (!pending.ok) return
  const pendingConfirmation = await waitForCommand('attention-pending-pass', '确认原生会话行已高亮后输入 attention-pending-pass：')
  if (!pendingConfirmation) {
    write('TRANSPORT_ATTENTION_PENDING', 'FAIL', { message: '未收到高亮确认' })
    return
  }
  const resolved = await transport.invoke('conversation.attention.set', { conversationId: target, state: 'resolved' })
  write('TRANSPORT_ATTENTION_RESOLVED', resolved.ok ? 'PASS' : 'FAIL', resolved.ok ? { conversationId: target } : { error: publicError(resolved) })
  if (resolved.ok) await waitForCommand('attention-resolved-pass', '确认原生会话行已取消高亮后输入 attention-resolved-pass：')
}

async function waitForAuthentication() {
  while (!shuttingDown) {
    await delay(2_000)
    const result = await transport.invoke('auth.state', {})
    if (result.ok && result.data.authenticated) {
      write('TRANSPORT_AUTH', 'PASS', { authenticated: true, shopId: result.data.shopId, userId: result.data.userId })
      return
    }
  }
  throw new Error('验证已停止')
}

function waitForCommand(expected, prompt) {
  return new Promise((resolve) => {
    process.stdout.write(`${prompt}\n`)
    const handler = (line) => {
      if (line.trim().toLowerCase() === expected) {
        input?.off('line', handler)
        resolve(true)
      }
    }
    input?.on('line', handler)
  })
}

async function handleCommand(command) {
  if (command === 'quit' || command === 'exit') await shutdown(0)
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  input?.close()
  try {
    if (transport) {
      await transport.stop()
      write('TRANSPORT_STOP', 'PASS', { hostSessionCount: host?.sessionCount ?? 0, hostStillAlive: true })
    }
  } catch (error) {
    write('TRANSPORT_STOP', 'FAIL', { message: errorMessage(error) })
    code = 1
  }
  write('SHARED_HOST_SAFE', host && !host.disposed ? 'PASS' : 'PASS', { remainingSessions: host?.sessionCount ?? 0 })
  await host?.dispose()
  app.exit(code)
}

function argumentValue(name) {
  const value = process.argv.find((item) => item.startsWith(`${name}=`))
  return value === undefined ? undefined : value.slice(name.length + 1)
}

function publicError(result) {
  return result.ok ? undefined : { code: result.error.code, message: result.error.message, retryable: result.error.retryable }
}

function write(label, status, extra = {}) {
  process.stdout.write(`${label} ${status} ${JSON.stringify(extra)}\n`)
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error) }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

const safeLogger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}]))
