import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, BrowserWindow } from 'electron'
import { HookHost } from '../packages/core-page-host/dist/index.js'
import {
  createDouyinElectronPageFactory,
  douyinHookManifest,
} from '../packages/douyin-hook/dist/index.js'

// This verifier deliberately runs the real HookSession in Electron. It does
// not copy browser cookies and does not use browser-session/Chrome.
const shopId = process.env.DOUYIN_VERIFY_SHOP_ID || `product-verification-${Date.now()}`
const partition = process.env.DOUYIN_VERIFY_PARTITION || 'persist:platform-hub-douyin-product-verification'
const userDataPath = process.env.DOUYIN_VERIFY_USER_DATA || join(tmpdir(), 'platform-hub-douyin-product-verification')
const productId = process.env.DOUYIN_VERIFY_PRODUCT_ID || ''
let host
let session
let input
let authTimer
let lastAuth
let baseline
let latest

app.setPath('userData', userDataPath)
app.whenReady().then(async () => {
  const factory = createDouyinElectronPageFactory({
    windowOptions: { width: 1440, height: 960 },
    // Show the products worker so a verifier can perform the required
    // on-sale/off-sale/title/price actions in the same Electron partition.
    createWindow: (context) => new BrowserWindow({
      width: 1440,
      height: 960,
      show: true,
      title: `Douyin 验收 · ${context.definition.id}`,
      webPreferences: {
        partition: context.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true,
      },
    }),
  })
  host = new HookHost({ pageFactory: factory })
  session = host.createSession(douyinHookManifest, {
    sessionId: `douyin-products-verification-${Date.now()}`,
    shopId,
    partition,
    maxWorkers: 1,
    // Keep the visible official product page alive while the verifier pauses
    // for a human to change listing state/title/price.
    workerIdleTtlMs: 10 * 60_000,
  })
  await session.start()
  authTimer = setInterval(() => { void checkAuth() }, 2_000)
  input = createInterface({ input: process.stdin, output: process.stdout })
  input.on('line', (line) => { void command(line.trim()) })
  write('READY', {
    environment: 'Electron BrowserWindow/WebContents',
    partition,
    commands: ['login', 'on-sale', 'off-sale', 'relist', 'title-update', 'price-update', 'pagination', 'dedupe', 'challenge', 'multi-shop', 'quit'],
  })
  write('NEED_HUMAN', '请在 Electron 官方抖店页面登录；登录完成后输入 login。')
}).catch((error) => fatal(error))

async function checkAuth() {
  if (!session?.isStarted) return
  const result = await session.invoke('auth.state', {}, { timeoutMs: 10_000 })
  const authenticated = result.ok && result.data.authenticated
  if (authenticated !== lastAuth) {
    lastAuth = authenticated
    write('AUTH', result.ok ? result.data : result.error)
    if (authenticated) write('NEED_HUMAN', '已登录。请先确认商品 A 在售，然后输入 on-sale。')
  }
}

async function listProducts(label) {
  const result = await session.invoke('products.list', {}, { timeoutMs: 60_000 })
  if (!result.ok) {
    write(label, result.error)
    return undefined
  }
  latest = result.data
  const ids = latest.map((item) => item.externalId)
  const summary = {
    count: latest.length,
    uniqueExternalIds: new Set(ids).size === ids.length,
    sample: latest.slice(0, 10).map((item) => ({ externalId: item.externalId, title: item.title, status: item.status, price: item.price })),
  }
  write(label, summary)
  return latest
}

async function command(value) {
  if (!value) return
  if (value === 'quit' || value === 'exit') return shutdown(0)
  if (value === 'login') {
    const result = await session.invoke('auth.state', {}, { timeoutMs: 15_000 })
    write('auth.state', result.ok ? result.data : result.error)
    return
  }
  if (value === 'on-sale') {
    baseline = await listProducts('PRODUCT_ON_SALE_VISIBLE')
    const selected = findProduct(baseline)
    write('PRODUCT_ON_SALE_VISIBLE', selected ? { pass: selected.status === 'on_sale', product: selected } : { pass: false, reason: '没有找到目标商品' })
    write('NEED_HUMAN', '请在官方后台将同一个商品 A 下架，完成后输入 off-sale。')
    return
  }
  if (value === 'off-sale') {
    const current = await listProducts('PRODUCT_OFF_SALE_REMOVED')
    const selected = findProduct(baseline)
    const removed = Boolean(selected && !current?.some((item) => item.externalId === selected.externalId))
    write('PRODUCT_OFF_SALE_REMOVED', { pass: removed, externalId: selected?.externalId })
    write('NEED_HUMAN', '请在官方后台重新上架商品 A，完成后输入 relist。')
    return
  }
  if (value === 'relist') {
    const current = await listProducts('PRODUCT_RELIST_VISIBLE')
    const selected = findProduct(baseline)
    const restored = Boolean(selected && current?.some((item) => item.externalId === selected.externalId))
    write('PRODUCT_RELIST_VISIBLE', { pass: restored, externalId: selected?.externalId })
    write('NEED_HUMAN', '请修改商品 A 标题并保存，完成后输入 title-update；随后再修改价格并输入 price-update。')
    return
  }
  if (value === 'title-update' || value === 'price-update') {
    const current = await listProducts(value === 'title-update' ? 'PRODUCT_TITLE_UPDATE' : 'PRODUCT_PRICE_UPDATE')
    const selected = findProduct(current)
    const previous = findProduct(latest === current ? baseline : latest)
    const changed = value === 'title-update' ? selected?.title !== previous?.title : JSON.stringify(selected?.price) !== JSON.stringify(previous?.price)
    write(value === 'title-update' ? 'PRODUCT_TITLE_UPDATE' : 'PRODUCT_PRICE_UPDATE', { pass: Boolean(changed), before: previous, after: selected })
    if (value === 'title-update') write('NEED_HUMAN', '请修改商品 A 价格并保存，完成后输入 price-update。')
    return
  }
  if (value === 'pagination') {
    const current = await listProducts('PRODUCT_FULL_PAGINATION')
    write('PRODUCT_FULL_PAGINATION', { pass: Array.isArray(current), count: current?.length || 0, note: '请与官方后台在售总数核对' })
    return
  }
  if (value === 'dedupe') {
    const current = latest || await listProducts('PRODUCT_NO_DUPLICATES')
    const ids = current?.map((item) => item.externalId) || []
    write('PRODUCT_NO_DUPLICATES', { pass: new Set(ids).size === ids.length, count: ids.length })
    return
  }
  if (value === 'challenge') {
    write('PRODUCT_CHALLENGE_NO_PARTIAL_SUCCESS', '请在官方商品页触发安全验证后再次运行 products.list；HookSession 必须等待官方验证，禁止返回 partial list。')
    return
  }
  if (value === 'multi-shop') {
    write('MULTI_SHOP_PRODUCT_ISOLATION', '请为店铺 A、B 分别使用不同 DOUYIN_VERIFY_PARTITION 运行本 Electron verifier，分别执行 products.list，并确认两边 externalId/title/price 不串店。')
    return
  }
  write('COMMAND', { accepted: false, available: ['login', 'on-sale', 'off-sale', 'relist', 'title-update', 'price-update', 'pagination', 'dedupe', 'challenge', 'multi-shop', 'quit'] })
}

function findProduct(products) {
  if (!products?.length) return undefined
  return productId ? products.find((item) => item.externalId === productId || item.id === productId) : products[0]
}

async function shutdown(code) {
  if (authTimer) clearInterval(authTimer)
  input?.close()
  await host?.dispose()
  app.exit(code)
}

function write(type, payload) {
  process.stdout.write(JSON.stringify({ type, payload, timestamp: Date.now() }, (_key, value) => typeof value === 'bigint' ? String(value) : value) + '\n')
}

function fatal(error) {
  write('FATAL', { message: error instanceof Error ? error.message : String(error) })
  app.exit(1)
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
