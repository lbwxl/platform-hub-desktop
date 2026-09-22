import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const port = process.env.DOUYIN_REAL_PUSH_CDP_PORT || '9349'
const listenMs = Number(process.env.DOUYIN_REAL_PUSH_LISTEN_MS || 60 * 60_000)
const logDirectory = join(process.cwd(), '.verify')
const logFile = process.env.DOUYIN_REAL_PUSH_LOG || join(logDirectory, 'douyin-real-push.jsonl')
const frontierEndpoint = 'wss://frontier.snssdk.com/ws/v2'
const marker = '__DOUYIN_REAL_PUSH_PROBE__'

mkdirSync(logDirectory, { recursive: true })

function write(type, data = {}) {
  const row = JSON.stringify({ type, timestamp: Date.now(), ...data })
  appendFileSync(logFile, `${row}\n`)
  process.stdout.write(`${row}\n`)
}

function redactedEndpoint(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[unavailable]'
  }
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function summarizePayload(value) {
  const text = typeof value === 'string' ? value : ''
  const orderIds = [...new Set(text.match(/(?<!\d)\d{19}(?!\d)/g) || [])].slice(0, 10)
  return {
    bytes: Buffer.byteLength(text),
    fingerprint: fingerprint(text),
    orderIds,
  }
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.error) reject(new Error(message.error.message || method))
      else resolve(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })

  return { socket, command }
}

async function findOrdersTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  for (const target of targets.filter((item) => item.type === 'page')) {
    const { socket, command } = await connect(target.webSocketDebuggerUrl)
    try {
      const result = await command('Runtime.evaluate', {
        expression: 'window.__PLATFORM_HOOK__?.describe?.()',
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.result?.value?.pageId === 'orders') return target
    } finally {
      socket.close()
    }
  }
  throw new Error('Electron CDP 中未找到 pageId === orders 的 persistent WebContents')
}

const target = await findOrdersTarget()
const { socket, command } = await connect(target.webSocketDebuggerUrl)
const frontierRequestIds = new Set()
const networkFrames = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const params = message.params
  if (!params) return

  if (message.method === 'Network.webSocketCreated') {
    const endpoint = redactedEndpoint(params.url)
    if (endpoint === frontierEndpoint) frontierRequestIds.add(params.requestId)
    write('network.websocket.created', {
      requestId: params.requestId,
      endpoint,
      frontier: endpoint === frontierEndpoint,
    })
    return
  }

  if (message.method === 'Network.webSocketClosed') {
    write('network.websocket.closed', {
      requestId: params.requestId,
      frontier: frontierRequestIds.has(params.requestId),
    })
    return
  }

  if (message.method === 'Network.webSocketFrameReceived') {
    const frame = {
      timestamp: Date.now(),
      requestId: params.requestId,
      frontier: frontierRequestIds.has(params.requestId),
      opcode: params.response?.opcode,
      ...summarizePayload(params.response?.payloadData || ''),
    }
    networkFrames.push(frame)
    if (networkFrames.length > 200) networkFrames.shift()
    write('network.websocket.frame.received', frame)
    return
  }

  if (message.method === 'Runtime.consoleAPICalled') {
    const text = params.args?.map((arg) => arg.value).find((value) => typeof value === 'string' && value.startsWith(marker))
    if (!text) return
    try {
      const runtime = JSON.parse(text.slice(marker.length))
      const correlatedFrames = networkFrames.filter((frame) => Math.abs(runtime.timestamp - frame.timestamp) < 2_000)
      write('runtime.frontier.message', {
        ...runtime,
        correlatedNetworkFrames: correlatedFrames.map((frame) => ({
          requestId: frame.requestId,
          frontier: frame.frontier,
          opcode: frame.opcode,
          fingerprint: frame.fingerprint,
        })),
      })
    } catch (error) {
      write('diagnostic.error', { method: 'Runtime.consoleAPICalled', message: String(error.message || error) })
    }
  }
})

await command('Network.enable', { maxResourceBufferSize: 2_000_000, maxTotalBufferSize: 20_000_000 })
await command('Runtime.enable')

const inspectionExpression = String.raw`(() => {
  const fws = window.frontierInstance?.fws
  const own = (value) => { try { return Object.getOwnPropertyNames(value || {}) } catch (_) { return [] } }
  const source = (value, name) => {
    try {
      const method = value?.[name] || Object.getPrototypeOf(value || {})?.[name]
      return typeof method === 'function' ? Function.prototype.toString.call(method).slice(0, 1_200) : undefined
    } catch (_) { return undefined }
  }
  const listenerSummary = Object.entries(fws?._listeners || {}).map(([event, listeners]) => {
    const values = Array.isArray(listeners) ? listeners : [listeners]
    return { event, count: values.filter(Boolean).length, names: values.filter(Boolean).slice(0, 20).map((listener) => listener?.name || 'anonymous') }
  })
  const decodeText = (bytes) => {
    try { return new TextDecoder().decode(bytes) } catch (_) { return '' }
  }
  const collectOrderIds = (value, found = new Set(), depth = 0, seen = new Set()) => {
    if (depth > 5 || value == null || seen.has(value)) return found
    if (typeof value === 'string') {
      for (const id of value.match(/(?<!\d)\d{19}(?!\d)/g) || []) found.add(id)
      return found
    }
    if (value instanceof Uint8Array) return collectOrderIds(decodeText(value), found, depth + 1, seen)
    if (typeof value !== 'object') return found
    seen.add(value)
    for (const key of Object.getOwnPropertyNames(value).slice(0, 100)) {
      try { collectOrderIds(value[key], found, depth + 1, seen) } catch (_) {}
    }
    return found
  }
  const summarize = (event) => {
    const message = event?.message
    const payload = message?.payload
    const textPayload = typeof message?.textPayload === 'string' ? message.textPayload : ''
    const orderIds = new Set([...collectOrderIds(event), ...collectOrderIds(textPayload)])
    return {
      timestamp: Date.now(),
      eventType: event?.type,
      messageKeys: own(message).slice(0, 100),
      payloadType: Object.prototype.toString.call(payload),
      payloadBytes: payload?.byteLength ?? payload?.length,
      payloadTypeName: message?.payloadType,
      payloadEncoding: message?.payloadEncoding,
      textPayloadBytes: textPayload.length,
      orderIds: [...orderIds].slice(0, 10),
    }
  }
  const summarizeNative = async (event) => {
    const data = event?.data
    let bytes
    try { bytes = data?.arrayBuffer ? new Uint8Array(await data.arrayBuffer()) : undefined } catch (_) {}
    const orderIds = bytes ? [...collectOrderIds(bytes)] : []
    return {
      timestamp: Date.now(),
      stage: 'native-websocket.message',
      dataType: Object.prototype.toString.call(data),
      bytes: bytes?.byteLength ?? data?.byteLength ?? data?.length,
      orderIds: orderIds.slice(0, 10),
    }
  }
  if (!fws || typeof fws.addEventListener !== 'function') return { error: 'frontierInstance.fws is unavailable' }
  const listener = (event) => {
    let output
    try {
      const message = event?.message
      const payload = message?.payload
      const payloadText = typeof payload === 'string' ? payload : payload instanceof Uint8Array ? decodeText(payload) : ''
      const parsed = payloadText ? (() => { try { return JSON.parse(payloadText) } catch (_) { return undefined } })() : undefined
      output = {
        timestamp: Date.now(),
        stage: 'fws.message',
        eventType: event?.type,
        messageKeys: own(message).slice(0, 100),
        payloadType: Object.prototype.toString.call(payload),
        payloadBytes: payload?.byteLength ?? payload?.length,
        payloadTypeName: message?.payloadType,
        payloadEncoding: message?.payloadEncoding,
        textPayloadBytes: typeof message?.textPayload === 'string' ? message.textPayload.length : 0,
        jsonTopLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 40) : [],
        orderIds: [...collectOrderIds(payloadText)].slice(0, 10),
      }
    } catch (error) {
      output = { timestamp: Date.now(), stage: 'fws.message.summary-error', message: String(error?.message || error).slice(0, 240) }
    }
    try { console.debug(marker + JSON.stringify(output)) } catch (_) {}
  }
  const nativeListener = (event) => {
    void summarizeNative(event).then((summary) => console.debug(marker + JSON.stringify(summary))).catch(() => {})
  }
  const errorListener = (event) => {
    try { console.debug(marker + JSON.stringify({ timestamp: Date.now(), stage: 'fws.error', message: String(event?.message || '').slice(0, 240) })) } catch (_) {}
  }
  fws.addEventListener('message', listener)
  fws.addEventListener('error', errorListener)
  fws._ws?.addEventListener?.('message', nativeListener)
  setTimeout(() => {
    try { fws.removeEventListener('message', listener) } catch (_) {}
    try { fws.removeEventListener('error', errorListener) } catch (_) {}
    try { fws._ws?.removeEventListener?.('message', nativeListener) } catch (_) {}
  }, ${listenMs})
  return {
    hook: window.__PLATFORM_HOOK__?.describe?.(),
    fws: {
      endpoint: (() => { try { const url = new URL(fws.url || fws._url); return url.origin + url.pathname } catch (_) { return '[unavailable]' } })(),
      readyState: fws.readyState,
      binaryType: fws.binaryType,
      ownPropertyNames: own(fws),
      prototypePropertyNames: own(Object.getPrototypeOf(fws)),
      listenerSummary,
      onmessageType: typeof fws.onmessage,
      addEventListenerType: typeof fws.addEventListener,
      removeEventListenerType: typeof fws.removeEventListener,
      nativeWebSocket: {
        readyState: fws._ws?.readyState,
        binaryType: fws._ws?.binaryType,
        addEventListenerType: typeof fws._ws?.addEventListener,
        removeEventListenerType: typeof fws._ws?.removeEventListener,
      },
      decoderMethods: {
        _onMessage: source(fws, '_onMessage'),
        _handleEvent: source(fws, '_handleEvent'),
        _dataToUnit8Array: source(fws, '_dataToUnit8Array'),
        _BlobToArrayBuffer: source(fws, '_BlobToArrayBuffer'),
        dispatchEvent: source(fws, 'dispatchEvent'),
      },
    },
  }
})()`

const inspection = await command('Runtime.evaluate', {
  expression: inspectionExpression,
  awaitPromise: true,
  returnByValue: true,
})
const runtime = inspection.result?.value
if (runtime?.error) throw new Error(runtime.error)
if (runtime?.hook?.pageId !== 'orders') throw new Error('目标页面不再是 orders persistent WebContents')
if (runtime?.fws?.endpoint !== frontierEndpoint) throw new Error(`orders 页面未连接预期 Frontier endpoint: ${runtime?.fws?.endpoint || 'unknown'}`)

write('capture.ready', {
  target: { id: target.id, url: redactedEndpoint(target.url) },
  logFile,
  listenMs,
  runtime,
})

const stop = () => {
  write('capture.stopped', { reason: 'timeout-or-signal' })
  socket.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
setTimeout(stop, listenMs)
