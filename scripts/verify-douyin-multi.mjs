import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app, BrowserWindow, session as electronSession } from 'electron'
import { HookHost } from '../packages/hook-host/dist/index.js'
import {
  createCdpEvaluator,
  createDouyinElectronPageFactory,
  douyinHookManifest,
} from '../packages/douyin-hook/dist/index.js'

const defaultSlots = [
  { id: 'shop-a', partition: 'persist:platform-hook-douyin-shop-a' },
  { id: 'shop-b', partition: 'persist:platform-hook-douyin-shop-b' },
]
const slots = parseSlots(process.env.DOUYIN_VERIFY_MULTI_SLOTS)
const userDataPath = process.env.DOUYIN_VERIFY_MULTI_USER_DATA || join(tmpdir(), 'platform-hub-douyin-multi-verification')
const logFile = process.env.DOUYIN_VERIFY_MULTI_LOG
const commandFile = process.env.DOUYIN_VERIFY_MULTI_COMMAND_FILE
const schedulerConcurrency = positiveInteger(process.env.DOUYIN_VERIFY_MULTI_WORKER_CONCURRENCY, 1)
const states = new Map(slots.map((slot) => [slot.id, {
  slot,
  sessionId: `douyin-multi-${slot.id}`,
  session: undefined,
  unsubscribe: undefined,
  authenticated: undefined,
  platformShopId: undefined,
  platformUserId: undefined,
  conversationId: undefined,
  snapshotRunning: false,
  authBusy: false,
  productRefs: [],
}]))
const evaluators = new Map()
const pageRecords = []
const windows = new Map()
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [
  level,
  (message, context) => {
    if (level === 'debug' && context?.operation === 'auth.state') return
    write('log', { level, message, context: safeContext(context) })
  },
]))

let host
let authTimer
let commandTimer
let input
let lastCommand = ''
let shutdownStarted = false
let lastCrossShopIdentityKey = ''

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('in-process-gpu')
if (process.env.DOUYIN_VERIFY_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.DOUYIN_VERIFY_DEBUG_PORT)
if (process.env.DOUYIN_VERIFY_PROXY_SERVER) {
  app.commandLine.appendSwitch('proxy-server', process.env.DOUYIN_VERIFY_PROXY_SERVER)
}
app.setPath('userData', userDataPath)
write('boot', { status: 'starting', slotCount: slots.length })

void app.whenReady().then(async () => {
  write('boot', { status: 'app-ready' })
  const factory = createDouyinElectronPageFactory({
    logger,
    createWindow: createVerificationWindow,
    evaluate: async (context, contents, expression) => {
      const evaluate = createCdpEvaluator(contents)
      evaluators.set(pageKey(context.shopId, context.definition.id), evaluate)
      return evaluate(expression)
    },
  })
  host = new HookHost({ pageFactory: factory, logger, maxWorkerConcurrency: schedulerConcurrency })
  await Promise.all(slots.map((slot) => startSlot(slot.id)))
  authTimer = setInterval(() => { void checkAllAuth() }, 2_000)
  if (commandFile) commandTimer = setInterval(() => { void readCommandFile() }, 500)
  input = createInterface({ input: process.stdin, output: process.stdout })
  input.on('line', (line) => { void handleCommand(line) })
  await checkAllAuth()
  write('ready', {
    hostSessionCount: host.sessionCount,
    schedulerConcurrencyLimit: host.scheduler.concurrencyLimit,
    sameSchedulerInstance: true,
    slots: slots.map((slot) => publicSlot(states.get(slot.id))),
    commands: ['status', 'snapshot', 'invoke', 'conversation.lookup', 'send.test', 'orders.prepare', 'orders.inspect', 'orders.scan', 'restart', 'dispose', 'create', 'identity.inspect', 'handoff.targets', 'handoff.inspect', 'handoff.transfer.test', 'quit'],
  })
}).catch((error) => {
  write('fatal', { message: errorMessage(error) })
  app.exit(1)
})

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

function createVerificationWindow(context) {
  const index = Math.max(0, slots.findIndex((slot) => slot.id === context.shopId))
  const primary = context.definition.kind === 'primary'
  const title = primary
    ? `Douyin Verify · ${context.shopId}`
    : `Douyin Verify · ${context.shopId} · ${context.definition.id}`
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    x: 50 + index * 90,
    y: 40 + index * 70,
    show: primary,
    title,
    webPreferences: {
      partition: context.partition,
      contextIsolation: false,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
  window.on('closed', () => {
    evaluators.delete(pageKey(context.shopId, context.definition.id))
    windows.delete(pageKey(context.shopId, context.definition.id))
    write('page.closed', operationContext(states.get(context.shopId), { pageId: context.definition.id }))
  })
  windows.set(pageKey(context.shopId, context.definition.id), window)
  pageRecords.push({
    localShopId: context.shopId,
    sessionId: context.sessionId,
    pageId: context.definition.id,
    kind: context.definition.kind,
    partition: context.partition,
    createdAt: Date.now(),
  })
  write('page.created', operationContext(states.get(context.shopId), {
    pageId: context.definition.id,
    kind: context.definition.kind,
    partition: context.partition,
    visible: primary,
    title,
  }))
  return window
}

async function startSlot(localShopId) {
  const state = requiredState(localShopId)
  if (state.session?.isStarted) return state.session
  const session = host.createSession(douyinHookManifest, {
    sessionId: state.sessionId,
    shopId: state.slot.id,
    partition: state.slot.partition,
    maxWorkers: 1,
    workerIdleTtlMs: 30_000,
  })
  state.session = session
  state.unsubscribe = session.subscribe((event) => write('event', summarizeEvent(state, event)))
  try {
    await session.start()
    write('slot.started', operationContext(state, { hostSessionCount: host.sessionCount }))
    return session
  } catch (error) {
    state.unsubscribe?.()
    state.unsubscribe = undefined
    state.session = undefined
    await host.disposeSession(state.sessionId)
    write('slot.start.failed', operationContext(state, { message: errorMessage(error) }))
    throw error
  }
}

async function disposeSlot(localShopId) {
  const state = requiredState(localShopId)
  state.unsubscribe?.()
  state.unsubscribe = undefined
  const disposed = await host.disposeSession(state.sessionId)
  state.session = undefined
  state.authenticated = undefined
  state.platformShopId = undefined
  state.platformUserId = undefined
  state.conversationId = undefined
  write('slot.disposed', operationContext(state, { disposed, hostSessionCount: host.sessionCount }))
  return disposed
}

async function restartSlot(localShopId) {
  const siblingsBefore = await siblingAuth(localShopId)
  write('slot.restart', operationContext(requiredState(localShopId), { status: 'started', siblingsBefore }))
  await disposeSlot(localShopId)
  await startSlot(localShopId)
  await checkAuth(requiredState(localShopId))
  const siblingsAfter = await siblingAuth(localShopId)
  write('slot.restart', operationContext(requiredState(localShopId), {
    status: 'completed',
    siblingsAfter,
    siblingIsolation: siblingStatesHealthy(siblingsBefore, siblingsAfter),
    sameHost: true,
    sameScheduler: true,
  }))
}

async function checkAllAuth() {
  await Promise.all([...states.values()].map((state) => checkAuth(state)))
  const active = [...states.values()].filter((state) => state.session?.isStarted && state.authenticated)
  if (active.length !== slots.length) return
  const identityKey = active
    .map((state) => `${state.slot.id}:${state.platformShopId || ''}:${state.platformUserId || ''}`)
    .sort()
    .join('|')
  if (!identityKey || identityKey === lastCrossShopIdentityKey) return
  lastCrossShopIdentityKey = identityKey
  void runCrossShopChecks(identityKey)
}

async function checkAuth(state) {
  if (state.authBusy || !state.session?.isStarted) return
  state.authBusy = true
  try {
    const result = await state.session.invoke('auth.state', {}, { timeoutMs: 10_000 })
    const authenticated = Boolean(result.ok && result.data.authenticated)
    const identityChanged = result.ok && (
      state.platformShopId !== result.data.shopId
      || state.platformUserId !== result.data.userId
    )
    const authChanged = authenticated !== state.authenticated
    if (result.ok) {
      state.platformShopId = result.data.shopId
      state.platformUserId = result.data.userId
    }
    state.authenticated = authenticated
    if (authChanged || identityChanged || !result.ok) {
      write('auth.state', operationContext(state, { result: summarizeResult('auth.state', result) }))
      await writePartitionEvidence(state)
    }
    if (authenticated && (authChanged || identityChanged)) void runSnapshot(state)
  } catch (error) {
    write('auth.check.failed', operationContext(state, { message: errorMessage(error) }))
  } finally {
    state.authBusy = false
  }
}

async function writePartitionEvidence(state) {
  const partitionSession = electronSession.fromPartition(state.slot.partition)
  const otherSessions = slots
    .filter((slot) => slot.id !== state.slot.id)
    .map((slot) => electronSession.fromPartition(slot.partition))
  let cookieCount
  try { cookieCount = (await partitionSession.cookies.get({})).length } catch { cookieCount = undefined }
  write('partition.evidence', operationContext(state, {
    cookieCount,
    distinctSessionObjects: otherSessions.every((candidate) => candidate !== partitionSession),
    partitionsUnique: new Set(slots.map((slot) => slot.partition)).size === slots.length,
  }))
}

async function runSnapshot(state) {
  if (state.snapshotRunning || !state.session?.isStarted || !state.authenticated) return
  state.snapshotRunning = true
  try {
    const sessions = await invokeLogged(state, 'sessions.list', {}, 15_000)
    state.conversationId = sessions.ok ? sessions.data[0]?.id : undefined
    if (state.conversationId) {
      await invokeLogged(state, 'messages.history', { conversationId: state.conversationId }, 15_000)
      await invokeLogged(state, 'messages.listen', {}, 10_000)
    }
    const products = await invokeLogged(state, 'products.list', {}, 30_000)
    state.productRefs = products.ok ? products.data.map((item) => ref(item.externalId || item.id)) : []
    await invokeLogged(state, 'orders.list', state.conversationId ? { conversationId: state.conversationId } : {}, 20_000)
    await invokeLogged(state, 'orders.listen', state.conversationId ? { conversationId: state.conversationId } : {}, 20_000)
  } catch (error) {
    write('snapshot.error', operationContext(state, { message: errorMessage(error) }))
  } finally {
    state.snapshotRunning = false
  }
}

async function runCrossShopChecks(identityKey) {
  const active = [...states.values()].filter((state) => state.session?.isStarted && state.authenticated)
  if (active.length < 2) return
  let observedMaxActive = host.scheduler.activeCount
  const monitor = setInterval(() => { observedMaxActive = Math.max(observedMaxActive, host.scheduler.activeCount) }, 5)
  let results
  try {
    results = await Promise.all(active.map((state) => invokeLogged(state, 'products.list', {}, 45_000)))
  } catch (error) {
    if (lastCrossShopIdentityKey === identityKey) lastCrossShopIdentityKey = ''
    write('multi.scheduler.failed', { message: errorMessage(error) })
    return
  } finally {
    clearInterval(monitor)
  }
  observedMaxActive = Math.max(observedMaxActive, host.scheduler.activeCount)
  const workerEvidence = active.map((state) => {
    const record = [...pageRecords].reverse().find((page) => page.localShopId === state.slot.id && page.kind === 'worker')
    return {
      localShopId: state.slot.id,
      primaryPartition: state.slot.partition,
      workerPartition: record?.partition,
      partitionMatches: record?.partition === state.slot.partition,
    }
  })
  write('multi.scheduler', {
    hostSessionCount: host.sessionCount,
    sameSchedulerInstance: true,
    schedulerConcurrencyLimit: host.scheduler.concurrencyLimit,
    observedMaxActive,
    allOperationsOk: results.every((result) => result.ok),
    workerEvidence,
  })
  write('multi.product-isolation', {
    slots: active.map((state, index) => {
      const productRefs = results[index].ok
        ? results[index].data.map((item) => ref(item.externalId || item.id))
        : []
      state.productRefs = productRefs
      return { localShopId: state.slot.id, platformShopId: ref(state.platformShopId), productRefs }
    }),
  })
}

async function invokeLogged(state, operation, inputValue = {}, timeoutMs = 20_000) {
  if (!state.session?.isStarted) return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: 'Slot session is not started' } }
  write('operation.started', operationContext(state, { operation }))
  const result = await state.session.invoke(operation, inputValue, { timeoutMs })
  if (operation === 'auth.state' && result.ok) {
    state.platformShopId = result.data.shopId
    state.platformUserId = result.data.userId
    state.authenticated = result.data.authenticated
  }
  write('operation.result', operationContext(state, { operation, result: summarizeResult(operation, result) }))
  return result
}

async function siblingAuth(excludedId) {
  const result = []
  for (const state of states.values()) {
    if (state.slot.id === excludedId || !state.session?.isStarted) continue
    const auth = await state.session.invoke('auth.state', {}, { timeoutMs: 10_000 })
    result.push({
      localShopId: state.slot.id,
      authenticated: Boolean(auth.ok && auth.data.authenticated),
      platformShopId: auth.ok ? ref(auth.data.shopId) : undefined,
      platformUserId: auth.ok ? ref(auth.data.userId) : undefined,
    })
  }
  return result
}

function siblingStatesHealthy(before, after) {
  return before.length === after.length && before.every((item) => after.some((candidate) => (
    candidate.localShopId === item.localShopId
    && candidate.authenticated === item.authenticated
    && candidate.platformShopId === item.platformShopId
    && candidate.platformUserId === item.platformUserId
  )))
}

async function handoffTargets(state) {
  if (!state.session?.isStarted) throw new Error(`Slot session is not started: ${state.slot.id}`)
  const result = await state.session.invoke('handoff.targets.list', {}, { timeoutMs: 15_000 })
  if (!result.ok) {
    write('handoff.targets', operationContext(state, { result: summarizeResult('handoff.targets.list', result) }))
    return { result, summary: { count: 0, distinctTargetCount: 0, targets: [] } }
  }
  const targets = result.data.slice(0, 30)
  const currentUserId = state.platformUserId || ''
  const summary = {
    currentUserRef: ref(currentUserId),
    count: targets.length,
    distinctTargetCount: targets.filter((item) => item.id !== currentUserId).length,
    targets: targets.map((item) => ({ idRef: ref(item.id), nameHint: maskName(item.name), isCurrent: item.id === currentUserId })),
  }
  write('handoff.targets', operationContext(state, summary))
  return { result, summary }
}

async function inspectIdentity(state) {
  const evaluate = evaluators.get(pageKey(state.slot.id, 'primary'))
  if (!evaluate) throw new Error(`Primary evaluator is not ready: ${state.slot.id}`)
  const entries = await evaluate(String.raw`(() => {
    const current = window.ss?._frontStore || window.ss?.instance
    const getters = window.__STORE__GETTERS__
    const getterValue = (name) => {
      try {
        const value = getters?.[name]
        return typeof value === 'function' && value.length === 0 ? value() : value
      } catch (_) { return undefined }
    }
    const sources = {
      selfInfo: current?.selfInfo,
      shopInfo: current?.shopInfo,
      frontStore: current,
      monaStore: window.__mona_store__,
      getterUser: getterValue('user'),
      getterShop: getterValue('shop'),
      getterShopInfo: getterValue('shopInfo'),
      getterCurrentShop: getterValue('currentShop'),
      getterCurrentUser: getterValue('currentUser'),
      getterMerchant: getterValue('merchant'),
      initContextData: window.__mona_pigeon_event?.globalStore?.data?.initContextData,
    }
    const useful = /(id|name|nick|staff|employee|operator|account|user|shop|role|tenant|seller|merchant|sub|agent|service)/i
    const blocked = /(token|cookie|credential|secret|phone|mobile|address|email|session|auth|ticket|csrf|password)/i
    const result = []
    for (const [sourceName, source] of Object.entries(sources)) {
      if (!source || typeof source !== 'object') continue
      const seen = new WeakSet()
      const pending = [{ value: source, path: sourceName, depth: 0 }]
      let visited = 0
      while (pending.length && visited < 500) {
        const node = pending.shift()
        if (!node?.value || typeof node.value !== 'object' || seen.has(node.value)) continue
        seen.add(node.value); visited += 1
        let keys = []
        try { keys = [...new Set([...Object.keys(node.value), ...Object.getOwnPropertyNames(node.value)])].slice(0, 120) } catch (_) {}
        for (const key of keys) {
          if (blocked.test(key)) continue
          let value
          try { value = node.value[key] } catch (_) { continue }
          const path = node.path + '.' + key
          if (['string', 'number', 'boolean'].includes(typeof value) && useful.test(key)) {
            const text = String(value).trim()
            if (text && text.length <= 256) result.push({ path, value: text, type: typeof value })
            if (result.length >= 120) return result
          } else if (value && typeof value === 'object' && node.depth < 4) {
            pending.push({ value, path, depth: node.depth + 1 })
          }
        }
      }
    }
    return result
  })()`)
  const summary = entries.map((item) => ({
    path: item.path,
    type: item.type,
    valueRef: ref(item.value),
    ...(/name|nick|title/i.test(item.path) ? { nameHint: maskName(item.value) } : {}),
  }))
  write('identity.evidence', operationContext(state, { fields: summary }))
  return summary
}

async function inspectHandoffRuntime(state, conversationId) {
  const evaluate = evaluators.get(pageKey(state.slot.id, 'primary'))
  if (!evaluate) throw new Error(`Primary evaluator is not ready: ${state.slot.id}`)
  const inspected = await evaluate(`(async () => {
    const conversationId = ${JSON.stringify(conversationId)}
    const store = window.ss?._frontStore || window.ss?.instance
    const chatRooms = store?.uiState?.chatRooms
    const room = chatRooms?.getChatRoom?.(conversationId)
    const shape = (value) => {
      if (!value) return null
      const levels = []
      let current = value
      for (let depth = 0; current && depth < 5; depth += 1) {
        const members = []
        for (const name of Object.getOwnPropertyNames(current)) {
          let member
          try { member = value[name] } catch (_) { continue }
          if (typeof member === 'function') members.push({ name, type: 'function', arity: member.length, source: String(member).slice(0, 1600) })
          else if (depth === 0 && member && typeof member === 'object') members.push({ name, type: Array.isArray(member) ? 'array' : 'object', keys: Object.keys(member).slice(0, 60) })
          else if (depth === 0 && ['string', 'number', 'boolean'].includes(typeof member)) members.push({ name, type: typeof member })
        }
        levels.push({ depth, members })
        current = Object.getPrototypeOf(current)
      }
      return levels
    }
    let lightRuntime
    try { lightRuntime = await window.__get_light_runtime?.() } catch (_) {}
    const roots = {
      ss: window.ss,
      store,
      monaRemotePigeon: window.mona_remote_pigeon,
      pluginLoader: window.__pigeonPluginLoader,
      monaEvent: window.__mona_pigeon_event,
      workbenchEvent: window.__WORKBENCH_EVENT_SDK_IN_WINDOW__,
      lightRuntime,
    }
    const discover = (interesting) => {
      const seen = new Set()
      const pending = Object.entries(roots).map(([path, value]) => ({ path, value, depth: 0 }))
      const found = []
      while (pending.length && seen.size < 15000 && found.length < 300) {
        const item = pending.shift()
        const value = item.value
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        let names = []
        try { names = Object.getOwnPropertyNames(value).slice(0, 1000) } catch (_) {}
        const methods = []
        for (const name of names) {
          let child
          try { child = value[name] } catch (_) { continue }
          if (typeof child === 'function' && interesting.test(name)) methods.push({ name, arity: child.length, source: String(child).slice(0, 1600) })
          if (item.depth < 7 && child && ['object', 'function'].includes(typeof child) && !/^(window|document|globalThis|parent|top|frames|prototype|__proto__|constructor|\$treenode)$/.test(name)) {
            pending.push({ path: item.path + '.' + name, value: child, depth: item.depth + 1 })
          }
        }
        if (methods.length) found.push({ path: item.path, methods })
      }
      return { visited: seen.size, found }
    }
    return {
      globalTransfer: shape(chatRooms?.transferConv),
      roomTransfer: shape(room?.transferConv),
      chatRooms: shape(chatRooms),
      room: shape(room),
      discovery: discover(/(transfer|assign|handoff|staff|service|conversation)/i),
      requestDiscovery: discover(/^(request|requestJson|post|postJson|http|callApi|invokeApi|fetchApi)$/i),
    }
  })()`)
  write('handoff.runtime.evidence', operationContext(state, { conversationRef: ref(conversationId), inspected }))
  return inspected
}

async function inspectOrderRuntime(state, conversationId, expectedOrderId = '') {
  const evaluate = evaluators.get(pageKey(state.slot.id, 'primary'))
  if (!evaluate) throw new Error(`Primary evaluator is not ready: ${state.slot.id}`)
  const inspected = await evaluate(`(async () => {
    const conversationId = ${JSON.stringify(conversationId)}
    const expectedOrderId = ${JSON.stringify(expectedOrderId)}
    const store = window.ss?._frontStore || window.ss?.instance
    const values = (value) => {
      if (!value) return []
      if (Array.isArray(value)) return [...value]
      try { if (typeof value.values === 'function') return [...value.values()] } catch (_) {}
      try { return Object.values(value) } catch (_) { return [] }
    }
    const snapshot = (value) => {
      try { return typeof value?.toJSON === 'function' ? value.toJSON() : value }
      catch (_) { return value }
    }
    const conversations = []
    for (const source of [store?.conversationsInfo?.unClosedConversations, store?.conversationsInfo?.closedConversations, store?.conversationsInfo?.conversations]) {
      for (const raw of values(source)) {
        const value = snapshot(raw) || raw || {}
        if (String(value.id || value.conversationId || '') === conversationId) conversations.push({ raw, value })
      }
    }
    const conversation = conversations[0]
    const buyerId = String(conversation?.value?.buyerId || conversation?.value?.currentTalkId || conversation?.value?.userId || '').trim()
    const post = window.__mona_pigeon_event?.globalStore?.data?.initContextData?.post
    if (!buyerId || typeof post !== 'function') return { buyerId, postAvailable: typeof post === 'function' }
    const endpoint = 'https://pigeon.jinritemai.com/backstage/cmpoent/order/query'
    const response = await post(endpoint, { page_size: 200, user_id: buyerId })
    const collectIds = (root, prefix) => {
      const result = []
      const seen = new Set()
      const pending = [{ value: root, path: prefix, depth: 0 }]
      while (pending.length && seen.size < 500 && result.length < 100) {
        const item = pending.shift()
        if (!item.value || typeof item.value !== 'object' || seen.has(item.value)) continue
        seen.add(item.value)
        let keys = []
        try { keys = Object.getOwnPropertyNames(item.value).slice(0, 200) } catch (_) {}
        for (const key of keys) {
          let child
          try { child = item.value[key] } catch (_) { continue }
          const path = item.path + '.' + key
          if (['string', 'number'].includes(typeof child) && /(id|uid|buyer|talk|user|customer|sender|from)/i.test(key) && !/(token|session|conversation|shop|self)/i.test(key)) {
            const text = String(child).trim()
            if (text && text.length <= 256) result.push({ path, value: text })
          } else if (child && typeof child === 'object' && item.depth < 3) {
            pending.push({ value: child, path, depth: item.depth + 1 })
          }
        }
      }
      return result
    }
    const directBuyerIds = [...new Set([
      conversation?.value?.buyerId,
      conversation?.value?.currentTalkId,
      conversation?.value?.userId,
      conversation?.raw?.buyerId,
      conversation?.raw?.currentTalkId,
      conversation?.raw?.userId,
    ].map((value) => String(value || '').trim()).filter(Boolean))]
    const talkers = directBuyerIds.map((id) => {
      try { return store?.talkerMap?.getTalkerInfo?.(id) } catch (_) { return undefined }
    }).filter(Boolean)
    let messageSource
    try { messageSource = store?.conversationsInfo?.messagesByConversationId?.get?.(conversationId) } catch (_) {}
    const messageRows = values(messageSource?.sortedMessages || messageSource?.visibleMessages || messageSource?.value || messageSource).slice(-20)
    const likelyCandidates = new Map()
    const addCandidate = (label, value) => {
      const id = String(value || '').trim()
      if (id && !likelyCandidates.has(id)) likelyCandidates.set(id, label)
    }
    addCandidate('buyerId', buyerId)
    addCandidate('currentTalkId', conversation?.value?.currentTalkId)
    addCandidate('shortId', conversation?.value?.shortId)
    addCandidate('conversationPrefix', String(conversationId).split(':')[0])
    addCandidate('securityFusionUid', conversation?.value?.rawExt?.security_fusion_uid)
    addCandidate('rawUserId', conversation?.value?.rawExt?.user_id)
    for (const message of messageRows) {
      const value = snapshot(message) || message || {}
      if (value.sender && value.sender !== store?.shopInfo?.id && value.sender !== store?.selfInfo?.id) addCandidate('messageSender', value.sender)
      addCandidate('messageExtFrom', value.ext?.from)
      addCandidate('messageSecuritySender', value.ext?.security_sender_id)
      addCandidate('messageSecurityUser', value.ext?.security_user_id)
      addCandidate('messageSecurityPigeonUser', value.ext?.security_pigeon_uid)
    }
    const candidateResults = []
    for (const [id, label] of [...likelyCandidates].slice(0, 12)) {
      try {
        const candidateResponse = id === buyerId ? response : await post(endpoint, { page_size: 200, user_id: id })
        candidateResults.push({
          id,
          label,
          code: candidateResponse?.code,
          total: candidateResponse?.total,
          size: candidateResponse?.size,
          dataLength: Array.isArray(candidateResponse?.data) ? candidateResponse.data.length : undefined,
        })
      } catch (error) {
        candidateResults.push({ id, label, error: String(error?.message || error || 'unknown error').slice(0, 160) })
      }
    }
    const shape = (value, depth = 0, seen = new Set()) => {
      if (value == null) return { type: String(value) }
      if (Array.isArray(value)) return {
        type: 'array',
        length: value.length,
        ...(depth < 5 && value.length ? { first: shape(value[0], depth + 1, seen) } : {}),
      }
      if (typeof value !== 'object') return { type: typeof value }
      if (seen.has(value)) return { type: 'circular' }
      seen.add(value)
      const result = { type: 'object', keys: Object.keys(value).slice(0, 80) }
      if (depth < 5) {
        result.children = Object.fromEntries(result.keys.map((key) => {
          let child
          try { child = value[key] } catch (_) { child = undefined }
          return [key, shape(child, depth + 1, seen)]
        }))
      }
      return result
    }
    const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined
    const orderScalars = (value) => {
      if (!value || typeof value !== 'object') return {}
      const result = {}
      for (const key of Object.getOwnPropertyNames(value).slice(0, 200)) {
        if (!/(order|status|amount|price|count|quantity|product|goods|sku|time)/i.test(key)) continue
        let child
        try { child = value[key] } catch (_) { continue }
        const safe = scalar(child)
        if (safe !== undefined && String(safe).length <= 240) result[key] = safe
      }
      return result
    }
    const findExpectedOrder = () => {
      if (!expectedOrderId) return { visited: 0, matches: [] }
      const roots = {
        store,
        storeGetters: window.__STORE__GETTERS__,
        initContextData: window.__mona_pigeon_event?.globalStore?.data?.initContextData,
        monaEvent: window.__mona_pigeon_event,
      }
      try {
        for (let index = 0; index < Math.min(window.frames.length, 20); index += 1) {
          const frame = window.frames[index]
          roots['frame' + index + '.store'] = frame.ss?._frontStore || frame.ss?.instance
          roots['frame' + index + '.storeGetters'] = frame.__STORE__GETTERS__
          roots['frame' + index + '.monaEvent'] = frame.__mona_pigeon_event
        }
      } catch (_) {}
      const seen = new Set()
      const pending = Object.entries(roots).map(([path, value]) => ({ path, value, parent: undefined, depth: 0 }))
      const matches = []
      while (pending.length && seen.size < 30000 && matches.length < 40) {
        const item = pending.shift()
        const value = item.value
        if (['string', 'number'].includes(typeof value)) {
          if (String(value) === expectedOrderId) {
            matches.push({
              path: item.path,
              parentKeys: item.parent && typeof item.parent === 'object' ? Object.keys(item.parent).slice(0, 100) : [],
              parentOrderScalars: orderScalars(item.parent),
            })
          }
          continue
        }
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        let names = []
        try { names = Object.getOwnPropertyNames(value).slice(0, 800) } catch (_) {}
        for (const name of names) {
          if (/^(window|document|globalThis|parent|top|frames|prototype|__proto__|constructor|ownerDocument|parentNode|children|childNodes)$/.test(name)) continue
          let child
          try { child = value[name] } catch (_) { continue }
          const path = item.path + '.' + name
          if (['string', 'number'].includes(typeof child)) {
            if (String(child) === expectedOrderId) matches.push({ path, parentKeys: names.slice(0, 100), parentOrderScalars: orderScalars(value) })
          } else if (item.depth < 9 && child && ['object', 'function'].includes(typeof child)) {
            pending.push({ path, value: child, parent: value, depth: item.depth + 1 })
          }
        }
      }
      return { visited: seen.size, matches }
    }
    const frameRuntime = () => {
      const result = []
      const count = Math.min(Number(window.frames?.length || 0), 20)
      for (let index = 0; index < count; index += 1) {
        try {
          const frame = window.frames[index]
          const frameStore = frame.ss?._frontStore || frame.ss?.instance
          result.push({
            index,
            accessible: true,
            hasStore: Boolean(frameStore),
            hasMonaEvent: Boolean(frame.__mona_pigeon_event),
            hasStoreGetters: Boolean(frame.__STORE__GETTERS__),
            windowKeys: Object.getOwnPropertyNames(frame).filter((key) => /(store|order|trade|query|cache|mona|pigeon)/i.test(key)).slice(0, 80),
            workstation: frameStore?.uiState?.workstation ? {
              currentOrder: scalar(frameStore.uiState.workstation.currentOrder),
              currentOrderMsgId: scalar(frameStore.uiState.workstation.currentOrderMsgId),
              isLoadOrderInfo: scalar(frameStore.uiState.workstation.isLoadOrderInfo),
            } : undefined,
          })
        } catch (_) {
          result.push({ index, accessible: false })
        }
      }
      return result
    }
    const discoverOrders = () => {
      const roots = {
        store,
        initContextData: window.__mona_pigeon_event?.globalStore?.data?.initContextData,
        monaEvent: window.__mona_pigeon_event,
      }
      const seen = new Set()
      const pending = Object.entries(roots).map(([path, value]) => ({ path, value, depth: 0 }))
      const found = []
      while (pending.length && seen.size < 12000 && found.length < 160) {
        const item = pending.shift()
        const value = item.value
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue
        seen.add(value)
        let names = []
        try { names = Object.getOwnPropertyNames(value).slice(0, 800) } catch (_) {}
        for (const name of names) {
          let child
          try { child = value[name] } catch (_) { continue }
          if (/order/i.test(name)) {
            found.push({
              path: item.path + '.' + name,
              type: Array.isArray(child) ? 'array' : typeof child,
              ...(typeof child === 'function' ? { arity: child.length, source: String(child).slice(0, 1200) } : {}),
              ...(child && typeof child === 'object' ? { keys: Object.keys(child).slice(0, 80), length: Array.isArray(child) ? child.length : undefined } : {}),
            })
          }
          if (item.depth < 7 && child && ['object', 'function'].includes(typeof child) && !/^(window|document|globalThis|parent|top|frames|prototype|__proto__|constructor|\$treenode)$/.test(name)) {
            pending.push({ path: item.path + '.' + name, value: child, depth: item.depth + 1 })
          }
        }
      }
      return { visited: seen.size, found }
    }
    return {
      buyerId,
      postAvailable: true,
      responseMeta: {
        code: response?.code,
        total: response?.total,
        page: response?.page,
        size: response?.size,
        messageType: typeof response?.msg,
      },
      candidateResults,
      selectedState: {
        workstation: {
          currentOrder: scalar(store?.uiState?.workstation?.currentOrder),
          currentOrderMsgId: scalar(store?.uiState?.workstation?.currentOrderMsgId),
          isLoadOrderInfo: scalar(store?.uiState?.workstation?.isLoadOrderInfo),
          serviceTaskOrderRefreshVersion: scalar(store?.uiState?.workstation?.serviceTaskOrderRefreshVersion),
        },
        historyConversation: {
          orderId: scalar(store?.historyConversationData?.orderId),
          orderInfo: shape(store?.historyConversationData?.orderInfo),
          conversationOrderIdList: shape(store?.historyConversationData?.conversationOrderIdList),
          subHistoryTagInfo: shape(store?.historyConversationData?.subHistoryTagInfo),
        },
        storeGetterKeys: Object.keys(window.__STORE__GETTERS__ || {}).filter((key) => /(order|trade|buyer|user|conversation)/i.test(key)).slice(0, 120),
        windowKeys: Object.getOwnPropertyNames(window).filter((key) => /(store|order|trade|query|cache|mona|pigeon)/i.test(key)).slice(0, 120),
        frames: frameRuntime(),
      },
      expectedOrder: findExpectedOrder(),
      orderDiscovery: discoverOrders(),
      identityCandidates: [
        ...collectIds(conversation?.value, 'conversation.value'),
        ...collectIds(conversation?.raw, 'conversation.raw'),
        ...talkers.flatMap((talker, index) => collectIds(talker, 'talker.' + index)),
        ...messageRows.flatMap((message, index) => collectIds(message, 'message.' + index)),
      ],
      response: shape(response),
    }
  })()`)
  const summary = {
    buyerRef: ref(inspected?.buyerId),
    postAvailable: inspected?.postAvailable === true,
    responseMeta: inspected?.responseMeta,
    candidateResults: (inspected?.candidateResults || []).map((item) => ({
      idRef: ref(item.id),
      label: item.label,
      code: item.code,
      total: item.total,
      size: item.size,
      dataLength: item.dataLength,
      error: item.error,
    })),
    selectedState: inspected?.selectedState,
    expectedOrder: inspected?.expectedOrder,
    orderDiscovery: inspected?.orderDiscovery,
    identityCandidates: (inspected?.identityCandidates || []).slice(0, 160).map((item) => ({ path: item.path, valueRef: ref(item.value) })),
    response: inspected?.response,
  }
  write('order.runtime.evidence', operationContext(state, { conversationRef: ref(conversationId), inspected: summary }))
  return summary
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
  if (!trimmed) return
  if (trimmed.startsWith('{')) {
    try {
      const request = JSON.parse(trimmed)
      const state = request.slot ? requiredState(request.slot) : undefined
      if (request.command === 'invoke' && state && request.operation) {
        const result = await invokeLogged(state, request.operation, request.input || {}, request.timeoutMs || 20_000)
        write('command.result', operationContext(state, { id: request.id, operation: request.operation, result: summarizeResult(request.operation, result) }))
        return
      }
      if (request.command === 'send.test' && state) {
        const marker = String(request.marker || '')
        if (!/^HOOK_MULTI_AUTO_[A-Z0-9_-]+$/.test(marker)) throw new Error('send.test requires a HOOK_MULTI_AUTO_* marker')
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('send.test requires an exact conversationTitle')
        const matches = await findConversationsByTitle(state, conversationTitle)
        if (matches.length !== 1) {
          throw new Error(`Expected exactly one conversation titled ${JSON.stringify(conversationTitle)} in ${state.slot.id}; found ${matches.length}`)
        }
        const conversationId = matches[0].id
        write('send.target', operationContext(state, {
          id: request.id,
          conversationRef: ref(conversationId),
          titleHint: maskName(conversationTitle),
        }))
        const result = await invokeLogged(state, 'messages.send.text', {
          conversationId,
          text: marker,
        }, request.timeoutMs || 20_000)
        write('command.result', operationContext(state, { id: request.id, operation: 'send.test', marker, result: summarizeResult('messages.send.text', result) }))
        return
      }
      if (request.command === 'conversation.lookup' && state) {
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('conversation.lookup requires an exact conversationTitle')
        const matches = await findConversationsByTitle(state, conversationTitle)
        write('command.result', operationContext(state, {
          id: request.id,
          operation: 'conversation.lookup',
          ok: true,
          titleHint: maskName(conversationTitle),
          count: matches.length,
          conversationRefs: matches.map((item) => ref(item.id)),
        }))
        return
      }
      if (request.command === 'orders.prepare' && state) {
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('orders.prepare requires an exact conversationTitle')
        const matches = await findConversationsByTitle(state, conversationTitle)
        if (matches.length !== 1) {
          throw new Error(`Expected exactly one conversation titled ${JSON.stringify(conversationTitle)} in ${state.slot.id}; found ${matches.length}`)
        }
        const conversationId = matches[0].id
        const snapshot = await invokeLogged(state, 'orders.list', { conversationId }, request.timeoutMs || 20_000)
        if (!snapshot.ok) throw new Error(`Unable to snapshot orders: ${state.slot.id}`)
        const listening = await invokeLogged(state, 'orders.listen', { conversationId }, request.timeoutMs || 20_000)
        if (!listening.ok) throw new Error(`Unable to listen for orders: ${state.slot.id}`)
        write('command.result', operationContext(state, {
          id: request.id,
          operation: 'orders.prepare',
          ok: true,
          titleHint: maskName(conversationTitle),
          conversationRef: ref(conversationId),
          snapshot: summarizeResult('orders.list', snapshot),
          listening: summarizeResult('orders.listen', listening),
        }))
        return
      }
      if (request.command === 'orders.inspect' && state) {
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('orders.inspect requires an exact conversationTitle')
        const matches = await findConversationsByTitle(state, conversationTitle)
        if (matches.length !== 1) {
          throw new Error(`Expected exactly one conversation titled ${JSON.stringify(conversationTitle)} in ${state.slot.id}; found ${matches.length}`)
        }
        const inspected = await inspectOrderRuntime(state, matches[0].id, String(request.expectedOrderId || '').trim())
        write('command.result', operationContext(state, { id: request.id, operation: 'orders.inspect', ok: true, inspected }))
        return
      }
      if (request.command === 'orders.scan' && state) {
        const sessions = await state.session.invoke('sessions.list', {}, { timeoutMs: request.timeoutMs || 20_000 })
        if (!sessions.ok) throw new Error(`Unable to list conversations: ${state.slot.id}`)
        const rows = []
        for (const conversation of sessions.data.slice(0, 30)) {
          const result = await state.session.invoke('orders.list', { conversationId: conversation.id }, { timeoutMs: request.timeoutMs || 20_000 })
          rows.push({
            conversationRef: ref(conversation.id),
            titleHint: maskName(conversation.title),
            ok: result.ok,
            count: result.ok ? result.data.length : 0,
            orders: result.ok ? result.data.map((order) => ({
              externalRef: ref(order.externalId),
              status: order.status,
              itemCount: order.items.length,
              quantities: order.items.map((item) => item.quantity),
              total: order.total,
              buyerRef: ref(order.buyer?.id),
              conversationRef: ref(order.conversationId),
            })) : [],
            error: result.ok ? undefined : result.error,
          })
        }
        write('command.result', operationContext(state, {
          id: request.id,
          operation: 'orders.scan',
          ok: rows.every((row) => row.ok),
          conversationCount: rows.length,
          orderCount: rows.reduce((total, row) => total + row.count, 0),
          rows,
        }))
        return
      }
      if (request.command === 'snapshot') {
        if (state) await runSnapshot(state)
        else await Promise.all([...states.values()].map((item) => runSnapshot(item)))
        write('command.result', { id: request.id, operation: 'snapshot', ok: true })
        return
      }
      if (request.command === 'restart' && state) {
        await restartSlot(state.slot.id)
        write('command.result', operationContext(state, { id: request.id, operation: 'restart', ok: true }))
        return
      }
      if (request.command === 'dispose' && state) {
        const siblingsBefore = await siblingAuth(state.slot.id)
        const disposed = await disposeSlot(state.slot.id)
        const siblingsAfter = await siblingAuth(state.slot.id)
        write('command.result', operationContext(state, {
          id: request.id,
          operation: 'dispose',
          ok: disposed,
          siblingIsolation: siblingStatesHealthy(siblingsBefore, siblingsAfter),
          siblingsAfter,
        }))
        return
      }
      if (request.command === 'create' && state) {
        await startSlot(state.slot.id)
        await checkAuth(state)
        write('command.result', operationContext(state, { id: request.id, operation: 'create', ok: true }))
        return
      }
      if (request.command === 'handoff.targets' && state) {
        const targets = await handoffTargets(state)
        write('command.result', operationContext(state, { id: request.id, operation: 'handoff.targets', ok: true, result: targets.summary }))
        return
      }
      if (request.command === 'handoff.inspect' && state) {
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('handoff.inspect requires an exact conversationTitle')
        const conversations = await findConversationsByTitle(state, conversationTitle)
        if (conversations.length !== 1) {
          throw new Error(`Expected exactly one conversation titled ${JSON.stringify(conversationTitle)} in ${state.slot.id}; found ${conversations.length}`)
        }
        const inspected = await inspectHandoffRuntime(state, conversations[0].id)
        write('command.result', operationContext(state, { id: request.id, operation: 'handoff.inspect', ok: true, sources: Object.fromEntries(Object.entries(inspected).map(([key, value]) => [key, value?.length || 0])) }))
        return
      }
      if (request.command === 'handoff.transfer.test' && state) {
        const conversationTitle = String(request.conversationTitle || '').trim()
        if (!conversationTitle) throw new Error('handoff.transfer.test requires an exact conversationTitle')
        const conversations = await findConversationsByTitle(state, conversationTitle)
        if (conversations.length !== 1) {
          throw new Error(`Expected exactly one conversation titled ${JSON.stringify(conversationTitle)} in ${state.slot.id}; found ${conversations.length}`)
        }
        const available = await handoffTargets(state)
        if (!available.result.ok) throw new Error(`Unable to list handoff targets: ${state.slot.id}`)
        const distinctTargets = available.result.data.filter((item) => item.id && item.id !== state.platformUserId)
        if (distinctTargets.length !== 1) {
          throw new Error(`Expected exactly one distinct handoff target in ${state.slot.id}; found ${distinctTargets.length}`)
        }
        const conversation = conversations[0]
        const target = distinctTargets[0]
        write('handoff.transfer.target', operationContext(state, {
          id: request.id,
          conversationRef: ref(conversation.id),
          titleHint: maskName(conversationTitle),
          targetRef: ref(target.id),
          targetNameHint: maskName(target.name),
        }))
        const result = await invokeLogged(state, 'handoff.transfer', {
          conversationId: conversation.id,
          targetId: target.id,
        }, request.timeoutMs || 20_000)
        write('command.result', operationContext(state, {
          id: request.id,
          operation: 'handoff.transfer.test',
          conversationRef: ref(conversation.id),
          targetRef: ref(target.id),
          targetNameHint: maskName(target.name),
          result: summarizeResult('handoff.transfer', result),
        }))
        return
      }
      if (request.command === 'identity.inspect' && state) {
        const fields = await inspectIdentity(state)
        write('command.result', operationContext(state, { id: request.id, operation: 'identity.inspect', ok: true, fieldCount: fields.length }))
        return
      }
      if (request.command === 'status') {
        write('command.result', {
          id: request.id,
          operation: 'status',
          ok: true,
          hostSessionCount: host.sessionCount,
          schedulerConcurrencyLimit: host.scheduler.concurrencyLimit,
          slots: [...states.values()].map(publicSlot),
        })
        return
      }
      if (request.command === 'quit') { await shutdown(0); return }
      throw new Error('Unknown command or missing slot')
    } catch (error) {
      write('command.result', { id: safeCommandId(trimmed), ok: false, error: { message: errorMessage(error) } })
      return
    }
  }
  if (trimmed.toLowerCase() === 'status') await handleCommand(JSON.stringify({ id: `status-${Date.now()}`, command: 'status' }))
  else if (['quit', 'exit'].includes(trimmed.toLowerCase())) await shutdown(0)
  else write('command.result', { ok: false, error: { message: 'Use a JSON command or status/quit' } })
}

async function findConversationsByTitle(state, conversationTitle) {
  const sessions = await invokeLogged(state, 'sessions.list', {}, 15_000)
  if (!sessions.ok) throw new Error(`Unable to list conversations: ${state.slot.id}`)
  return sessions.data.filter((item) => item.title === conversationTitle)
}

async function shutdown(code) {
  if (shutdownStarted) return
  shutdownStarted = true
  if (authTimer) clearInterval(authTimer)
  if (commandTimer) clearInterval(commandTimer)
  input?.close()
  await host?.dispose()
  write('shutdown', { status: 'completed' })
  app.exit(code)
}

function summarizeEvent(state, event) {
  const message = event.payload?.message
  const order = event.payload?.order
  return operationContext(state, {
    eventType: event.type,
    timestamp: event.timestamp,
    ...(message ? { message: {
      idRef: ref(message.id),
      conversationRef: ref(message.conversationId),
      direction: message.direction,
      origin: message.origin,
      type: message.type,
      deliveryStatus: message.deliveryStatus,
      timestamp: message.timestamp,
      marker: /^HOOK_MULTI_[A-Z_]+_\d+$/.test(message.content || '') ? message.content : undefined,
      contentLength: typeof message.content === 'string' ? message.content.length : undefined,
      manualSendCheck: message.raw?.attributionMetadata?.manualSendCheck,
    } } : {}),
    ...(order ? { order: {
      externalRef: ref(order.externalId),
      status: order.status,
      itemCount: order.items?.length,
      quantity: order.items?.reduce((total, item) => total + (Number(item.quantity) || 0), 0),
      total: order.total,
      buyerRef: ref(order.buyer?.id),
      conversationRef: ref(order.conversationId),
      platformStatus: order.raw?.platformStatus,
    }, previous: event.payload.previous ? {
      status: event.payload.previous.status,
      itemCount: event.payload.previous.items?.length,
      quantity: event.payload.previous.items?.reduce((total, item) => total + (Number(item.quantity) || 0), 0),
      total: event.payload.previous.total,
      platformStatus: event.payload.previous.raw?.platformStatus,
    } : undefined, changedFields: event.payload.changedFields } : {}),
    ...(event.type === 'runtime.error' ? { errorMessage: event.payload?.message } : {}),
  })
}

function summarizeResult(operation, result) {
  if (!result.ok) return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } }
  if (operation === 'auth.state') return {
    ok: true,
    data: {
      authenticated: result.data.authenticated,
      platformShopId: ref(result.data.shopId),
      platformUserId: ref(result.data.userId),
    },
  }
  if (operation === 'messages.send.text' || operation === 'messages.send.file') {
    return {
      ok: true,
      data: {
        idRef: ref(result.data.id),
        conversationRef: ref(result.data.conversationId),
        senderRef: ref(result.data.senderId),
        type: result.data.type,
        direction: result.data.direction,
        origin: result.data.origin,
        deliveryStatus: result.data.deliveryStatus,
        timestamp: result.data.timestamp,
      },
    }
  }
  if (Array.isArray(result.data)) {
    if (operation === 'sessions.list') return {
      ok: true,
      count: result.data.length,
      items: result.data.slice(0, 10).map((item) => ({ conversationRef: ref(item.id), unreadCount: item.unreadCount })),
    }
    if (operation === 'messages.history') return {
      ok: true,
      count: result.data.length,
      items: result.data.slice(-20).map((item) => ({
        idRef: ref(item.id),
        conversationRef: ref(item.conversationId),
        direction: item.direction,
        origin: item.origin,
        type: item.type,
        deliveryStatus: item.deliveryStatus,
        marker: /^HOOK_MULTI_[A-Z_]+_\d+$/.test(item.content || '') ? item.content : undefined,
      })),
    }
    if (operation === 'products.list') return {
      ok: true,
      count: result.data.length,
      items: result.data.slice(0, 10).map((item) => ({ externalRef: ref(item.externalId), status: item.status, price: item.price, stockQuantity: item.stockQuantity })),
    }
    if (operation === 'orders.list') return {
      ok: true,
      count: result.data.length,
      items: result.data.slice(0, 10).map((item) => ({
        externalRef: ref(item.externalId),
        status: item.status,
        itemCount: item.items?.length,
        quantity: item.items?.reduce((total, line) => total + (Number(line.quantity) || 0), 0),
        total: item.total,
        buyerRef: ref(item.buyer?.id),
        conversationRef: ref(item.conversationId),
        platformStatus: item.raw?.platformStatus,
      })),
    }
    return { ok: true, count: result.data.length }
  }
  const data = result.data && typeof result.data === 'object' ? result.data : { value: result.data }
  return { ok: true, data: redact(data) }
}

function operationContext(state, extra = {}) {
  return {
    localShopId: state?.slot.id,
    sessionId: state?.sessionId,
    partition: state?.slot.partition,
    platformShopId: ref(state?.platformShopId),
    platformUserId: ref(state?.platformUserId),
    ...extra,
  }
}

function publicSlot(state) {
  return operationContext(state, {
    authenticated: state.authenticated,
    started: Boolean(state.session?.isStarted),
    disposed: state.session ? state.session.isDisposed : undefined,
    conversationRef: ref(state.conversationId),
    productRefs: state.productRefs,
  })
}

function requiredState(id) {
  const state = states.get(String(id || ''))
  if (!state) throw new Error(`Unknown slot: ${id}`)
  return state
}

function parseSlots(raw) {
  const value = raw ? JSON.parse(raw) : defaultSlots
  if (!Array.isArray(value) || value.length < 2) throw new Error('DOUYIN_VERIFY_MULTI_SLOTS must contain at least two slots')
  const normalized = value.map((item) => ({ id: String(item?.id || '').trim(), partition: String(item?.partition || '').trim() }))
  if (normalized.some((item) => !/^[a-z0-9][a-z0-9_-]*$/i.test(item.id))) throw new Error('Slot id is invalid')
  if (normalized.some((item) => !item.partition.startsWith('persist:'))) throw new Error('Each slot partition must be persistent')
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('Slot ids must be unique')
  if (new Set(normalized.map((item) => item.partition)).size !== normalized.length) throw new Error('Slot partitions must be unique')
  return normalized
}

function pageKey(localShopId, pageId) { return `${localShopId}:${pageId}` }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback }
function errorMessage(error) { return error instanceof Error ? error.message : String(error) }
function ref(value) { return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : undefined }
function maskName(value) { const text = String(value || ''); return text ? `${text.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, text.length - 1)))}` : '***' }
function safeCommandId(value) { try { return JSON.parse(value)?.id } catch { return undefined } }
function safeContext(context = {}) { return Object.fromEntries(Object.entries(context).filter(([key]) => !/(content|address|phone|cookieValue|token|credential|raw)/i.test(key))) }
function redact(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => !/(content|address|phone|cookie|token|credential|raw)/i.test(key)).map(([key, item]) => [key, Array.isArray(item) ? { count: item.length } : item])) }

function write(type, payload) {
  const line = `${JSON.stringify({ type, timestamp: Date.now(), ...payload })}\n`
  process.stdout.write(line)
  if (logFile) {
    try { appendFileSync(logFile, line, 'utf8') } catch { /* stdout remains available */ }
  }
}
