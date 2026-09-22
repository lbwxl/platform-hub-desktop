import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.env.DOUYIN_DECODED_FRONTIER_CDP_PORT || '9349'
const listenMs = Number(process.env.DOUYIN_DECODED_FRONTIER_LISTEN_MS || 60 * 60_000)
const marker = '__DOUYIN_DECODED_FRONTIER_PROBE__'
const stateKey = '__DOUYIN_DECODED_FRONTIER_PROBE_STATE__'
const frontierEndpoint = 'wss://frontier.snssdk.com/ws/v2'
const logDirectory = join(process.cwd(), '.verify')
const logFile = process.env.DOUYIN_DECODED_FRONTIER_LOG || join(logDirectory, 'douyin-decoded-frontier-frames.jsonl')

mkdirSync(logDirectory, { recursive: true })

function write(type, data = {}) {
  const row = JSON.stringify({ type, timestamp: Date.now(), ...data })
  appendFileSync(logFile, `${row}\n`)
  process.stdout.write(`${row}\n`)
}

function endpoint(value) {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '[unavailable]'
  }
}

async function createCdpConnection(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const notifications = new Set()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message || 'CDP command failed'))
      else request.resolve(message.result)
      return
    }
    for (const listener of notifications) listener(message)
  })

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })

  return {
    socket,
    command,
    onNotification(listener) {
      notifications.add(listener)
      return () => notifications.delete(listener)
    },
  }
}

async function findOrdersTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  for (const target of targets.filter((item) => item.type === 'page')) {
    const cdp = await createCdpConnection(target.webSocketDebuggerUrl)
    try {
      const description = await cdp.command('Runtime.evaluate', {
        expression: 'window.__PLATFORM_HOOK__?.describe?.()',
        awaitPromise: true,
        returnByValue: true,
      })
      if (description.result?.value?.pageId === 'orders') return target
    } finally {
      cdp.socket.close()
    }
  }
  throw new Error('Electron CDP 中未找到 pageId === orders 的 persistent WebContents')
}

const target = await findOrdersTarget()
const cdp = await createCdpConnection(target.webSocketDebuggerUrl)
const frames = []
let breakpointId
let observerInstalled = false
let stopped = false
let requestStop
let stopRequested = false

function stop() {
  stopRequested = true
  requestStop?.()
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)

function addFrame(params) {
  const payload = params.response?.payloadData || ''
  const frame = {
    timestamp: Date.now(),
    requestId: params.requestId,
    opcode: params.response?.opcode,
    bytes: Buffer.byteLength(payload),
  }
  frames.push(frame)
  if (frames.length > 200) frames.shift()
  return frame
}

function correlatedFrames(timestamp) {
  return frames
    .filter((frame) => Math.abs(timestamp - frame.timestamp) < 2_000)
    .map(({ requestId, opcode, bytes }) => ({ requestId, opcode, bytes }))
}

const removeNotificationListener = cdp.onNotification((message) => {
  const params = message.params
  if (!params) return

  if (message.method === 'Network.webSocketCreated') {
    write('network.websocket.created', {
      requestId: params.requestId,
      endpoint: endpoint(params.url),
      frontier: endpoint(params.url) === frontierEndpoint,
    })
    return
  }

  if (message.method === 'Network.webSocketClosed') {
    write('network.websocket.closed', { requestId: params.requestId })
    return
  }

  if (message.method === 'Network.webSocketFrameReceived') {
    write('network.websocket.frame.received', addFrame(params))
    return
  }

  if (message.method === 'Runtime.consoleAPICalled') {
    const text = params.args?.map((arg) => arg.value).find((value) => typeof value === 'string' && value.startsWith(marker))
    if (!text) return
    try {
      const runtime = JSON.parse(text.slice(marker.length))
      write('runtime.decoded-frame', {
        ...runtime,
        correlatedNetworkFrames: correlatedFrames(runtime.timestamp),
      })
    } catch (error) {
      write('diagnostic.error', { method: 'Runtime.consoleAPICalled', message: String(error.message || error) })
    }
  }
})

const helperExpression = String.raw`(() => {
  const stateKey = '${stateKey}'
  const marker = '${marker}'
  const previous = window[stateKey]
  try { previous?.restore?.() } catch (_) {}

  const blocked = /token|cookie|authorization|credential|secret|password|phone|mobile|address|receiver|buyer|avatar|image|header_value/i
  const semantic = new Set(['event', 'eventtype', 'type', 'biz', 'biztype', 'business', 'businesstype', 'service', 'method', 'topic', 'category', 'channel', 'route', 'command', 'cmd', 'status', 'code', 'payloadtype', 'payloadencoding', 'encoding', 'version', 'protocol', 'appid', 'aid'])
  const own = (value) => { try { return Object.getOwnPropertyNames(value || {}).filter((key) => !blocked.test(key)).slice(0, 80) } catch (_) { return [] } }
  const constructorName = (value) => { try { return value?.constructor?.name || Object.prototype.toString.call(value) } catch (_) { return '[unavailable]' } }
  const redactedUrl = (value) => { try { const url = new URL(value); return url.origin + url.pathname } catch (_) { return undefined } }
  const numericTokens = (value) => typeof value === 'string' ? [...new Set(value.match(/(?<!\d)\d{19}(?!\d)/g) || [])].slice(0, 10) : []
  const primitive = (key, value) => {
    if (typeof value === 'string') {
      const item = { key, kind: 'string', length: value.length, nineteenDigitValues: numericTokens(value) }
      const url = /^https?:\/\//i.test(value) ? redactedUrl(value) : undefined
      if (url) item.url = url
      if (semantic.has(key.replace(/[^a-z]/ig, '').toLowerCase()) && /^[A-Za-z0-9._:/-]{1,160}$/.test(value)) item.value = value
      return item
    }
    if (typeof value === 'number' || typeof value === 'boolean') return { key, kind: typeof value, value }
    if (typeof value === 'bigint') return { key, kind: 'bigint', value: String(value) }
    if (value instanceof Uint8Array) return { key, kind: 'Uint8Array', byteLength: value.byteLength }
    if (value instanceof ArrayBuffer) return { key, kind: 'ArrayBuffer', byteLength: value.byteLength }
    return undefined
  }
  const inspect = (value, depth = 0, seen = new Set()) => {
    if (value == null || typeof value !== 'object' || seen.has(value) || depth > 5) return { kind: value == null ? String(value) : typeof value }
    if (value instanceof Uint8Array) return { kind: 'Uint8Array', byteLength: value.byteLength }
    if (value instanceof ArrayBuffer) return { kind: 'ArrayBuffer', byteLength: value.byteLength }
    seen.add(value)
    const keys = own(value)
    const node = { constructor: constructorName(value), ownPropertyNames: keys, primitiveFields: [], nested: {} }
    if (keys.includes('key') && keys.includes('value') && typeof value.key === 'string') {
      node.headerKey = blocked.test(value.key) ? '[redacted]' : value.key.slice(0, 160)
    }
    for (const key of keys) {
      let child
      try { child = value[key] } catch (_) { continue }
      const item = primitive(key, child)
      if (item) node.primitiveFields.push(item)
      else if (child && typeof child === 'object' && depth < 5 && Object.keys(node.nested).length < 24) node.nested[key] = inspect(child, depth + 1, seen)
    }
    const encoding = typeof value.payloadEncoding === 'string' ? value.payloadEncoding.replace(/\s/g, '').toLowerCase() : ''
    const payloadType = typeof value.payloadType === 'string' ? value.payloadType.replace(/\s/g, '').toLowerCase() : ''
    if (value.payload instanceof Uint8Array && encoding === 'utf8' && payloadType === 'json') {
      try {
        const payloadText = new TextDecoder().decode(value.payload)
        node.payloadJson = { bytes: value.payload.byteLength, structure: inspect(JSON.parse(payloadText), depth + 1, seen) }
      } catch (error) {
        node.payloadJson = { bytes: value.payload.byteLength, parseError: String(error?.message || error).slice(0, 160) }
      }
    }
    return node
  }
  const state = {
    installedAt: Date.now(),
    record(stage, value) {
      try { console.debug(marker + JSON.stringify({ timestamp: Date.now(), stage, structure: inspect(value) })) } catch (_) {}
    },
    restore() {
      try {
        if (this.frame && this.originalDecode && this.frame.decode === this.decodeWrapper) this.frame.decode = this.originalDecode
        if (this.fws && this.dispatchWrapper && this.fws.dispatchEvent === this.dispatchWrapper) {
          if (this.dispatchWasOwn) this.fws.dispatchEvent = this.originalDispatch
          else delete this.fws.dispatchEvent
        }
      } catch (_) {}
    },
  }
  window[stateKey] = state
  return { ready: true }
})()`

async function installObserverFromClosure() {
  let resolvePause
  const paused = new Promise((resolve) => { resolvePause = resolve })
  const removePausedListener = cdp.onNotification(async (message) => {
    if (message.method !== 'Debugger.paused' || observerInstalled) return
    try {
      const frame = message.params.callFrames?.[0]
      const installed = await cdp.command('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: String.raw`(() => {
          const state = window['${stateKey}']
          const fws = window.frontierInstance?.fws
          if (!state || !fws || !pbbp2?.Frame?.decode) return { installed: false, reason: 'decoder unavailable' }
          state.fws = fws
          state.frame = pbbp2.Frame
          state.originalDecode = pbbp2.Frame.decode
          state.originalDispatch = fws.dispatchEvent
          state.dispatchWasOwn = Object.prototype.hasOwnProperty.call(fws, 'dispatchEvent')
          state.decodeWrapper = function (...args) {
            const result = state.originalDecode.apply(this, args)
            state.record('pbbp2.Frame.decode', result)
            return result
          }
          state.dispatchWrapper = function (event) {
            state.record('fws.dispatchEvent.before', event)
            return state.originalDispatch.call(this, event)
          }
          pbbp2.Frame.decode = state.decodeWrapper
          fws.dispatchEvent = state.dispatchWrapper
          return {
            installed: true,
            decoderSource: Function.prototype.toString.call(decodedFrame),
            decodeSource: Function.prototype.toString.call(state.originalDecode),
            toObjectSource: Function.prototype.toString.call(pbbp2.Frame.toObject),
            onMessageSource: Function.prototype.toString.call(fws._onMessage),
            dataToUint8ArraySource: Function.prototype.toString.call(fws._dataToUnit8Array),
            blobToArrayBufferSource: Function.prototype.toString.call(fws._BlobToArrayBuffer),
            dispatchEventSource: Function.prototype.toString.call(state.originalDispatch),
          }
        })()`,
        returnByValue: true,
      })
      const value = installed.result?.value
      if (!value?.installed) throw new Error(value?.reason || 'decoder observer was not installed')
      observerInstalled = true
      write('frontier.decoder.source', { target: target.id, sourceFile: logFile, ...value })
    } catch (error) {
      write('diagnostic.error', { method: 'Debugger.evaluateOnCallFrame', message: String(error.message || error) })
    } finally {
      try { await cdp.command('Debugger.resume') } catch (_) {}
      resolvePause()
    }
  })

  const functionResult = await cdp.command('Runtime.evaluate', {
    expression: 'window.frontierInstance?.fws?._onMessage',
    returnByValue: false,
  })
  if (!functionResult.result?.objectId) throw new Error('frontierInstance.fws._onMessage is unavailable')
  const breakpoint = await cdp.command('Debugger.setBreakpointOnFunctionCall', { objectId: functionResult.result.objectId })
  breakpointId = breakpoint.breakpointId
  await Promise.race([paused, new Promise((resolve) => setTimeout(resolve, 45_000))])
  removePausedListener()
  if (breakpointId) {
    await cdp.command('Debugger.removeBreakpoint', { breakpointId })
    breakpointId = undefined
  }
  if (!observerInstalled) throw new Error('Timed out before the Electron Frontier decoder closure became observable')
}

async function restoreObserver() {
  await cdp.command('Runtime.evaluate', {
    expression: String.raw`(() => { const state = window['${stateKey}']; try { state?.restore?.() } finally { delete window['${stateKey}'] } return true })()`,
    returnByValue: true,
  }).catch(() => {})
}

try {
  await cdp.command('Network.enable', { maxResourceBufferSize: 2_000_000, maxTotalBufferSize: 20_000_000 })
  await cdp.command('Runtime.enable')
  await cdp.command('Debugger.enable')
  const helper = await cdp.command('Runtime.evaluate', { expression: helperExpression, returnByValue: true })
  if (!helper.result?.value?.ready) throw new Error('Unable to install decoded-frame observer helper')

  const description = await cdp.command('Runtime.evaluate', {
    expression: 'window.__PLATFORM_HOOK__?.describe?.()',
    returnByValue: true,
  })
  if (description.result?.value?.pageId !== 'orders') throw new Error('目标页面不再是 orders persistent WebContents')

  await installObserverFromClosure()
  write('capture.ready', {
    target: { id: target.id, url: endpoint(target.url) },
    logFile,
    listenMs,
    decoder: 'pbbp2.Frame.decode',
    dispatch: 'frontierInstance.fws.dispatchEvent',
  })

  let timeoutId
  try {
    await Promise.race([
      new Promise((resolve) => { timeoutId = setTimeout(resolve, listenMs) }),
      new Promise((resolve) => {
        requestStop = resolve
        if (stopRequested) resolve()
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
} finally {
  if (breakpointId) await cdp.command('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})
  await restoreObserver()
  removeNotificationListener()
  if (!stopped) {
    stopped = true
    write('capture.stopped', { reason: 'timeout-or-signal' })
  }
  cdp.socket.close()
}
