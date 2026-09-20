import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import { HookHost } from '../packages/hook-host/dist/index.js'
import {
  createDouyinElectronPageFactory,
  createCdpEvaluator,
  douyinHookManifest,
} from '../packages/douyin-hook/dist/index.js'

const shopId = process.env.DOUYIN_VERIFY_SHOP_ID || 'local-verification'
const partition = process.env.DOUYIN_VERIFY_PARTITION || 'persist:platform-hook-douyin-verification'
const userDataPath = process.env.DOUYIN_VERIFY_USER_DATA || join(tmpdir(), 'platform-hub-douyin-verification')
const logFile = process.env.DOUYIN_VERIFY_LOG
const commandFile = process.env.DOUYIN_VERIFY_COMMAND_FILE
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [
  level,
  (message, context) => write('log', { level, message, context: safeContext(context) }),
]))

let host
let session
let snapshotRunning = false
let lastAuthenticated
let authTimer
let commandTimer
let input
let lastCommand = ''
let primaryEvaluate

app.disableHardwareAcceleration()
app.setPath('userData', userDataPath)
write('boot', { status: 'starting' })
void app.whenReady().then(async () => {
  write('boot', { status: 'app-ready' })
  await start()
  authTimer = setInterval(() => { void checkAuth() }, 2_000)
  if (commandFile) commandTimer = setInterval(() => { void readCommandFile() }, 500)
  input = createInterface({ input: process.stdin, output: process.stdout })
  input.on('line', (line) => { void handleCommand(line) })

  write('ready', {
    page: douyinHookManifest.pages.find((page) => page.kind === 'primary')?.url,
    partition,
    commands: ['snapshot', 'restart', 'quit'],
    sideEffectsEnabled: {
      sendText: Boolean(process.env.DOUYIN_VERIFY_SEND_TEXT),
      sendFile: Boolean(process.env.DOUYIN_VERIFY_FILE),
      handoff: Boolean(process.env.DOUYIN_VERIFY_HANDOFF_TARGET_ID || process.env.DOUYIN_VERIFY_HANDOFF_TARGET_NAME),
    },
  })
}).catch((error) => {
  write('fatal', { message: error instanceof Error ? error.message : String(error) })
  app.exit(1)
})
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

async function start() {
  write('boot', { status: 'creating-session' })
  const factory = createDouyinElectronPageFactory({
    logger,
    windowOptions: { width: 1280, height: 860 },
    evaluate: async (context, contents, expression) => {
      const evaluate = createCdpEvaluator(contents)
      if (context.definition.kind === 'primary') primaryEvaluate = evaluate
      return evaluate(expression)
    },
  })
  host = new HookHost({ pageFactory: factory, logger })
  session = host.createSession(douyinHookManifest, {
    sessionId: `douyin-verification-${Date.now()}`,
    shopId,
    partition,
    maxWorkers: 1,
    workerIdleTtlMs: 30_000,
  })
  session.subscribe((event) => write('event', summarizeEvent(event)))
  write('boot', { status: 'starting-session' })
  await session.start()
  write('boot', { status: 'session-started' })
  await checkAuth()
}

async function checkAuth() {
  if (!session?.isStarted) return
  const result = await session.invoke('auth.state', {}, { timeoutMs: 10_000 })
  const authenticated = result.ok && result.data.authenticated
  if (authenticated !== lastAuthenticated || !result.ok) write('auth.state', summarizeResult(result))
  const becameAuthenticated = authenticated && lastAuthenticated !== true
  lastAuthenticated = authenticated
  if (becameAuthenticated) await runSnapshot()
}

async function runSnapshot() {
  if (snapshotRunning || !session?.isStarted) return
  snapshotRunning = true
  try {
    const auth = await session.invoke('auth.state', {}, { timeoutMs: 10_000 })
    write('auth.state', summarizeResult(auth))
    if (!auth.ok || !auth.data.authenticated) return

    const sessions = await session.invoke('sessions.list', {}, { timeoutMs: 15_000 })
    write('sessions.list', summarizeResult(sessions))
    const conversationId = process.env.DOUYIN_VERIFY_CONVERSATION_ID || (sessions.ok ? sessions.data[0]?.id : undefined)
    if (conversationId) {
      write('messages.history', summarizeResult(await session.invoke('messages.history', { conversationId }, { timeoutMs: 15_000 })))
      write('messages.listen', summarizeResult(await session.invoke('messages.listen', {}, { timeoutMs: 10_000 })))
    }

    const products = await session.invoke('products.list', {}, { timeoutMs: 30_000 })
    write('products.list', summarizeResult(products))
    const productId = process.env.DOUYIN_VERIFY_PRODUCT_ID || (products.ok ? products.data[0]?.id : undefined)
    if (productId) write('products.detail', summarizeResult(await session.invoke('products.detail', { id: productId }, { timeoutMs: 20_000 })))

    write('orders.list', summarizeResult(await session.invoke('orders.list', conversationId ? { conversationId } : {}, { timeoutMs: 20_000 })))
    write('orders.listen', summarizeResult(await session.invoke('orders.listen', conversationId ? { conversationId } : {}, { timeoutMs: 20_000 })))

    if (conversationId && process.env.DOUYIN_VERIFY_SEND_TEXT) {
      write('messages.send.text', summarizeResult(await session.invoke('messages.send.text', {
        conversationId,
        text: process.env.DOUYIN_VERIFY_SEND_TEXT,
      }, { timeoutMs: 20_000 })))
    }
    if (conversationId && process.env.DOUYIN_VERIFY_FILE) {
      const mimeType = process.env.DOUYIN_VERIFY_FILE_MIME || 'image/png'
      const data = `data:${mimeType};base64,${(await readFile(process.env.DOUYIN_VERIFY_FILE)).toString('base64')}`
      write('messages.send.file', summarizeResult(await session.invoke('messages.send.file', {
        conversationId,
        data,
        name: process.env.DOUYIN_VERIFY_FILE.split(/[\\/]/).at(-1),
        mimeType,
      }, { timeoutMs: 60_000 })))
    }
    if (conversationId && (process.env.DOUYIN_VERIFY_HANDOFF_TARGET_ID || process.env.DOUYIN_VERIFY_HANDOFF_TARGET_NAME)) {
      write('handoff.transfer', summarizeResult(await session.invoke('handoff.transfer', {
        conversationId,
        targetId: process.env.DOUYIN_VERIFY_HANDOFF_TARGET_ID,
        targetName: process.env.DOUYIN_VERIFY_HANDOFF_TARGET_NAME,
      }, { timeoutMs: 20_000 })))
    }
  } catch (error) {
    write('snapshot.error', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    snapshotRunning = false
  }
}

async function restart() {
  write('restart', { status: 'started' })
  await host?.dispose()
  host = undefined
  session = undefined
  lastAuthenticated = undefined
  await start()
  write('restart', { status: 'completed' })
}

async function shutdown(code) {
  if (authTimer) clearInterval(authTimer)
  if (commandTimer) clearInterval(commandTimer)
  input?.close()
  await host?.dispose()
  app.exit(code)
}

async function readCommandFile() {
  try {
    const command = (await readFile(commandFile, 'utf8')).trim()
    if (command && command !== lastCommand) {
      lastCommand = command
      await handleCommand(command.split(/\r?\n/).at(-1))
    }
  } catch { /* command file is optional */ }
}

async function handleCommand(line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const request = JSON.parse(trimmed)
      if (request.command === 'invoke' && request.operation) {
        const result = await session.invoke(request.operation, request.input || {}, { timeoutMs: request.timeoutMs || 20_000 })
        write('command.result', { id: request.id, operation: request.operation, result: summarizeResult(result) })
        return
      }
      if (request.command === 'handoff.targets') {
        if (!primaryEvaluate) throw new Error('Primary page evaluator is not ready')
        const targets = await primaryEvaluate(String.raw`(async () => {
          const transfer = (window.ss?._frontStore || window.ss?.instance)?.uiState?.chatRooms?.transferConv
          if (!transfer) return []
          if (!transfer.canTransferServiceList?.length && typeof transfer.fetchTransferServiceList === 'function') await transfer.fetchTransferServiceList()
          if (!transfer.canTransferGroupList?.length && typeof transfer.fetchTransferGroupList === 'function') await transfer.fetchTransferGroupList()
          const text = (value) => value == null ? '' : String(value)
          return [...(transfer.canTransferServiceList || []), ...(transfer.canTransferGroupList || [])].slice(0, 30).map((item) => ({
            id: text(item?.id || item?.staffId || item?.userId),
            name: text(item?.name || item?.title || item?.staffName) || '未命名目标',
          })).filter((item) => item.id)
        })()`)
        write('command.result', { id: request.id, operation: 'handoff.targets', result: { ok: true, count: targets.length, items: targets } })
        return
      }
    } catch (error) {
      write('command', { accepted: false, message: error instanceof Error ? error.message : String(error) })
      return
    }
  }
  const command = trimmed.toLowerCase()
  if (command === 'snapshot') void runSnapshot()
  else if (command === 'restart') void restart()
  else if (command === 'quit' || command === 'exit') void shutdown(0)
  else write('command', { accepted: false, available: ['snapshot', 'restart', 'quit'] })
}

function summarizeResult(result) {
  if (!result.ok) return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } }
  if (Array.isArray(result.data)) return {
    ok: true,
    count: result.data.length,
    items: result.data.slice(0, 10).map((item) => ({
      id: item?.id,
      externalId: item?.externalId,
      title: item?.title,
      unreadCount: item?.unreadCount,
      status: item?.status,
      origin: item?.origin,
      type: item?.type,
      direction: item?.direction,
      deliveryStatus: item?.deliveryStatus,
      timestamp: item?.timestamp,
      conversationId: item?.conversationId,
      price: item?.price,
      stockQuantity: item?.stockQuantity,
      imageCount: item?.images?.length,
      skuCount: item?.skus?.length,
      platformStatus: item?.raw?.platformStatus,
      contentMarker: /^HOOK_TEST_[A-Z]+_\d+$/.test(item?.content?.trim?.() || '') ? item.content.trim() : undefined,
      attributionMetadata: /^HOOK_TEST_[A-Z]+_\d+$/.test(item?.content?.trim?.() || '') ? item?.raw?.attributionMetadata : undefined,
    })),
  }
  const data = result.data && typeof result.data === 'object' ? result.data : { value: result.data }
  return { ok: true, data: redact(data) }
}

function summarizeEvent(event) {
  const message = event.payload?.message
  const order = event.payload?.order
  return {
    type: event.type,
    timestamp: event.timestamp,
    ...(message ? { message: {
      id: message.id,
      conversationId: message.conversationId,
      direction: message.direction,
      origin: message.origin,
      type: message.type,
      deliveryStatus: message.deliveryStatus,
      timestamp: message.timestamp,
      contentMarker: /^HOOK_TEST_[A-Z]+_\d+$/.test(message.content || '') ? message.content : undefined,
      contentLength: typeof message.content === 'string' ? message.content.length : undefined,
      source: message.raw?.source,
      senderRole: message.raw?.senderRole,
      attributionMetadata: message.raw?.attributionMetadata,
    } } : {}),
    ...(order ? { order: { id: order.id, externalId: order.externalId, conversationId: order.conversationId, status: order.status }, changedFields: event.payload.changedFields } : {}),
    ...(event.type === 'runtime.error' ? { message: event.payload?.message } : {}),
  }
}

function safeContext(context = {}) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !/(content|address|phone|cookie|token|credential|raw)/i.test(key)))
}

function redact(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(content|address|phone|cookie|token|credential|raw)/i.test(key)).map(([key, item]) => [key, Array.isArray(item) ? { count: item.length } : item]))
}

function write(type, payload) {
  const line = `${JSON.stringify({ type, timestamp: Date.now(), ...payload })}\n`
  process.stdout.write(line)
  if (logFile) {
    try { appendFileSync(logFile, line, 'utf8') } catch { /* stdout remains available */ }
  }
}
