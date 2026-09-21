import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { app, BrowserWindow } from 'electron'

process.stdout.write(JSON.stringify({ type: 'boot', timestamp: Date.now(), status: 'module-loaded' }) + '\\n')

const partition = process.env.DOUYIN_ORDER_EVENTS_PARTITION || 'persist:platform-hook-douyin-shop-a'
// Use the established merchant origin; record the real landing route rather than guessing it.
const entry = process.env.DOUYIN_ORDER_EVENTS_URL || 'https://fxg.jinritemai.com/'
const logDir = join(process.cwd(), '.verify')
mkdirSync(logDir, { recursive: true })
const logFile = process.env.DOUYIN_ORDER_EVENTS_LOG || join(logDir, 'douyin-order-events.jsonl')
const relevant = /order|trade|refund|after.?sale|payment|paid|ship|notif|notice|message|socket|event|subscribe/i
const blocked = /name|phone|mobile|address|cookie|token|secret|credential|password|receiver|buyer|avatar|header/i
const permitted = /^(?:.*(?:order|trade|refund|aftersale|after_sale|shop)[_-]?id|id|type|event|event_type|biz_type|status|.*_status|code|timestamp|time|create_time|update_time|count|total|amount|quantity)$/i
const counts = new Map()
function safe(value, depth = 0) {
  if (depth > 7) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, 30).map(v => safe(v, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  const out = {}
  for (const [key, v] of Object.entries(value).slice(0, 150)) {
    if (blocked.test(key)) continue
    if (v && typeof v === 'object') out[key] = safe(v, depth + 1)
    else if (typeof v === 'string' && /^[\[{]/.test(v.trim())) { try { out[key] = safe(JSON.parse(v), depth + 1) } catch {} }
    else if (permitted.test(key) && ['string','number','boolean'].includes(typeof v)) out[key] = String(v).slice(0, 160)
    else out[key] = `[${typeof v}]`
  }
  return out
}
function write(type, data = {}) { const row = JSON.stringify({ type, timestamp: Date.now(), partition, ...data }) + '\n'; appendFileSync(logFile, row); process.stdout.write(row) }
function payload(source, text, extra = {}) {
  const hash = createHash('sha256').update(text).digest('hex')
  const duplicateCount = (counts.get(hash) || 0) + 1
  counts.set(hash, duplicateCount)
  if (counts.size > 5000) counts.delete(counts.keys().next().value)
  let data
  try { data = safe(JSON.parse(text)) } catch { data = { format: 'non-json', bytes: Buffer.byteLength(text) } }
  write('payload', { source, fingerprint: hash.slice(0, 16), duplicateCount, data, ...extra })
}
const inventory = `(() => {
  const match = /order|trade|refund|after.?sale|payment|paid|ship|notif|notice|message|socket|event|subscribe|store|sdk|bus/i;
  const roots = Object.getOwnPropertyNames(window).filter(k => match.test(k));
  const objects = [];
  for (const key of roots.slice(0,100)) {
    const d = Object.getOwnPropertyDescriptor(window,key); const value = d?.value;
    if (!value || !['object','function'].includes(typeof value)) continue;
    let keys=[]; try { keys=Object.getOwnPropertyNames(value).slice(0,150) } catch {}
    const methods=keys.filter(k=>{try{return typeof Object.getOwnPropertyDescriptor(value,k)?.value==='function'}catch{return false}});
    objects.push({path:'window.'+key, keys, methods});
  }
  return { origin:location.origin, pathname:location.pathname, roots, objects };
})()`
// Match the known-good verification runners in this repository. In the
// restricted desktop runtime Chromium's GPU process can stall before the
// app-ready event, which otherwise leaves no CDP endpoint for inspection.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('in-process-gpu')
process.stdout.write(JSON.stringify({ type: 'boot', timestamp: Date.now(), status: 'switches-set' }) + '\\n')
app.setPath('userData', process.env.DOUYIN_ORDER_EVENTS_USER_DATA || join(tmpdir(), 'platform-hub-douyin-multi-verification'))
process.stdout.write(JSON.stringify({ type: 'boot', timestamp: Date.now(), status: 'path-set' }) + '\\n')
if (process.env.DOUYIN_VERIFY_PROXY_SERVER) app.commandLine.appendSwitch('proxy-server', process.env.DOUYIN_VERIFY_PROXY_SERVER)
app.commandLine.appendSwitch('remote-debugging-port', process.env.DOUYIN_ORDER_EVENTS_DEBUG_PORT || '9333')
process.stdout.write(JSON.stringify({ type: 'boot', timestamp: Date.now(), status: 'waiting-ready' }) + '\\n')
void app.whenReady().then(async () => {
  write('boot', { status: 'app-ready' })
  write('boot', { status: 'creating-window' })
  const win = new BrowserWindow({ width:1280, height:900, show:true, title:'Douyin Order Events Inspector', webPreferences:{partition,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} })
  write('boot', { status: 'window-created' })
  const cdp = win.webContents.debugger
  write('boot', { status: 'attaching-debugger' })
  cdp.attach('1.3')
  write('boot', { status: 'debugger-attached' })
  const requests = new Map()
  cdp.on('message', async (_event, method, p) => {
  try {
    if (method === 'Network.webSocketCreated') write('websocket.created', {requestId:p.requestId, endpoint: new URL(p.url).origin + new URL(p.url).pathname})
    if (method === 'Network.webSocketFrameReceived') payload('websocket', p.response.payloadData, {requestId:p.requestId,opcode:p.response.opcode})
    if (method === 'Network.eventSourceMessageReceived') payload('sse', p.data, {requestId:p.requestId,eventName:p.eventName})
    if (method === 'Network.responseReceived') {
      const u = new URL(p.response.url)
      if (/jinritemai\.com$/.test(u.hostname) && ['XHR','Fetch','EventSource'].includes(p.type)) {
        const endpoint = u.origin + u.pathname
        write('response', { requestId:p.requestId,endpoint,status:p.response.status })
        if (relevant.test(u.pathname)) requests.set(p.requestId, endpoint)
      }
    }
    if (method === 'Network.loadingFinished' && requests.has(p.requestId)) {
      const endpoint=requests.get(p.requestId); requests.delete(p.requestId)
      if(p.encodedDataLength > 2_000_000) return
      const body=await cdp.sendCommand('Network.getResponseBody',{requestId:p.requestId})
      payload(endpoint,body.base64Encoded ? Buffer.from(body.body,'base64').toString('utf8') : body.body)
    }
    if(method === 'Network.loadingFailed') requests.delete(p.requestId)
  } catch(error) { write('diagnostic.error', {method, message:String(error.message).slice(0,180)}) }
  })
  const command = (method, params) => Promise.race([
    cdp.sendCommand(method, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), 5000)),
  ])
  void command('Network.enable',{maxResourceBufferSize:2_000_000,maxTotalBufferSize:10_000_000})
    .then(() => write('boot', { status: 'network-enabled' }))
    .catch(error => write('diagnostic.error', { method: 'Network.enable', message: String(error.message) }))
  void command('Runtime.enable')
    .then(() => write('boot', { status: 'runtime-enabled' }))
    .catch(error => write('diagnostic.error', { method: 'Runtime.enable', message: String(error.message) }))
  write('capture.ready',{entry})
  win.webContents.on('did-finish-load', async () => {
  try {
    const result=await command('Runtime.evaluate',{expression:inventory,returnByValue:true})
    write('runtime.inventory',result.result.value || {})
    write('capture.active',{note:'Network capture active; authentication and source readiness still require verification.'})
  } catch(error) { write('inventory.error',{message:String(error.message)}) }
  })
  win.on('closed',()=>app.quit())
  process.on('SIGINT',()=>app.quit())
  await win.loadURL(entry).catch(error=>write('navigation.error',{message:String(error.message)}))
}).catch(error => {
  write('fatal', { message: String(error?.stack || error) })
  app.quit()
})
// The window stays alive while the user performs the real order flow. No automatic timeout.
