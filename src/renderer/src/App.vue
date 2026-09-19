<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Activity, Bot, Boxes, Download, MessageSquare, Paperclip, Plus, ReceiptText, RefreshCw, Send, Settings2, Store, Trash2, Wifi } from 'lucide-vue-next'
import type { ChatSession, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
import { upsertPlatformMessage } from '../../shared/messageMerge'

const platforms = ref<PlatformDefinition[]>([])
const accounts = ref<PlatformAccount[]>([])
const activeAccountId = ref('')
const selectedPlatform = ref('douyin-shop')
const label = ref('')
const products = ref<ProductRecord[]>([])
const sessions = ref<ChatSession[]>([])
const messages = ref<PlatformMessage[]>([])
const activeSessionId = ref('')
const draft = ref('')
const logs = ref<PlatformEvent[]>([])
const status = ref<PlatformStatus | null>(null)
const busy = ref('')
const toast = ref('')
const messageList = ref<HTMLElement | null>(null)
let disposeEvents: (() => void) | undefined

const activeAccount = computed(() => accounts.value.find((item) => item.id === activeAccountId.value))
const activePlatform = computed(() => platforms.value.find((item) => item.id === (activeAccount.value?.platform || selectedPlatform.value)))
const activeSessions = computed(() => sessions.value)
const unreadCount = computed(() => sessions.value.reduce((sum, item) => sum + (item.unread || 0), 0))

function notify(message: string): void { toast.value = message; window.setTimeout(() => { if (toast.value === message) toast.value = '' }, 2800) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function scrollMessagesToEnd(): void { void nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight }) }
function eventSummary(event: PlatformEvent): string {
  if (!event.payload || typeof event.payload !== 'object') return String(event.payload || '')
  if (event.type === 'message') {
    const message = event.payload as PlatformMessage
    return JSON.stringify({ sender: message.senderName, content: message.content, type: message.type, mine: message.isMine })
  }
  if (event.type === 'order') {
    const payload = event.payload as { order?: { orderId?: string; status?: string }; sessionId?: string }
    return JSON.stringify({ orderId: payload.order?.orderId, status: payload.order?.status, sessionId: payload.sessionId })
  }
  const payload = event.payload as Record<string, unknown>
  return JSON.stringify({ message: payload.message, connected: payload.connected, authenticated: payload.authenticated })
}

async function refresh(): Promise<void> {
  platforms.value = await window.platformApi.platforms.list()
  accounts.value = await window.platformApi.accounts.list()
  if (!activeAccountId.value || !accounts.value.some((item) => item.id === activeAccountId.value)) activeAccountId.value = accounts.value[0]?.id || ''
  if (activeAccountId.value) {
    await inspect(activeAccountId.value)
    if (status.value?.authenticated) await refreshSessions(false)
  }
}

async function addAccount(): Promise<void> {
  busy.value = 'add'
  try {
    const account = await window.platformApi.accounts.add({ platform: selectedPlatform.value, label: label.value || activePlatform.value?.label || '平台账号' })
    label.value = ''; accounts.value.push(account); activeAccountId.value = account.id
    await window.platformApi.accounts.open(account.id)
    notify('已打开平台页面；若页面要求登录，请直接在页面中完成登录')
  } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function openAccount(account: PlatformAccount): Promise<void> {
  activeAccountId.value = account.id; busy.value = `open:${account.id}`
  try { await window.platformApi.accounts.open(account.id); await inspect(account.id); notify('平台页面已打开，Hook 将自动等待登录') } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function inspect(accountId: string): Promise<void> {
  try {
    status.value = await window.platformApi.status(accountId)
    const account = accounts.value.find((item) => item.id === accountId)
    if (account) { account.connected = status.value.connected; account.authenticated = status.value.authenticated }
  } catch (error) { notify(errorMessage(error)) }
}

async function collect(): Promise<void> {
  if (!activeAccountId.value) return notify('请先添加平台账号')
  busy.value = 'products'
  try { products.value = await window.platformApi.collectProducts(activeAccountId.value); notify(`商品采集完成，共 ${products.value.length} 件`) } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function loadSessions(): Promise<void> {
  await refreshSessions(true)
}

async function refreshSessions(showSuccess: boolean): Promise<void> {
  if (!activeAccountId.value) return notify('请先添加平台账号')
  busy.value = 'sessions'
  try {
    sessions.value = await window.platformApi.sessions(activeAccountId.value)
    if (!sessions.value.some((item) => item.id === activeSessionId.value)) activeSessionId.value = sessions.value[0]?.id || ''
    if (activeSessionId.value) await loadMessages(activeSessionId.value)
    if (showSuccess) notify(`已读取 ${sessions.value.length} 个会话`)
  } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function loadMessages(sessionId = activeSessionId.value): Promise<void> {
  if (!activeAccountId.value || !sessionId) { messages.value = []; return }
  busy.value = 'messages'
  try { messages.value = await window.platformApi.messages(activeAccountId.value, sessionId); scrollMessagesToEnd() } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function selectSession(sessionId: string): Promise<void> {
  activeSessionId.value = sessionId
  await loadMessages(sessionId)
}

async function send(): Promise<void> {
  if (!activeAccountId.value || !activeSessionId.value || !draft.value.trim()) return
  busy.value = 'send'
  try { const result = await window.platformApi.sendMessage(activeAccountId.value, activeSessionId.value, draft.value.trim()); if (!result.success) throw new Error(result.error || '发送失败'); draft.value = ''; await loadMessages(); notify('消息已发送') } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function sendImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !activeAccountId.value || !activeSessionId.value) return
  busy.value = 'file'
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
      reader.readAsDataURL(file)
    })
    const result = await window.platformApi.sendFile(activeAccountId.value, activeSessionId.value, dataUrl, file.name)
    if (!result.success) throw new Error(result.error || '图片发送失败')
    await loadMessages()
    notify('图片已发送')
  } catch (error) { notify(errorMessage(error)) } finally { busy.value = '' }
}

async function removeAccount(account: PlatformAccount): Promise<void> {
  if (!window.confirm(`确定移除“${account.label}”吗？该账号的登录会话也会断开。`)) return
  await window.platformApi.accounts.remove(account.id); await refresh(); notify('账号已移除')
}

async function importHook(): Promise<void> {
  try { const platform = await window.platformApi.platforms.importPackage(); if (platform) { await refresh(); selectedPlatform.value = platform.id; notify(`已导入 ${platform.label} Hook 包`) } } catch (error) { notify(errorMessage(error)) }
}

function pushEvent(event: PlatformEvent): void {
  logs.value = [event, ...logs.value].slice(0, 80)
  if (event.accountId !== activeAccountId.value) return
  if (event.type === 'connection') {
    const wasAuthenticated = status.value?.authenticated === true
    status.value = event.payload as PlatformStatus
    const account = accounts.value.find((item) => item.id === event.accountId)
    if (account) { account.connected = status.value.connected; account.authenticated = status.value.authenticated }
    if (!wasAuthenticated && status.value.authenticated) void refreshSessions(false)
  }
  if (event.type === 'message') {
    const message = event.payload as PlatformMessage
    let session = sessions.value.find((item) => item.id === message.sessionId)
    if (!session) {
      session = { id: message.sessionId, title: message.senderName || '新会话', unread: 0 }
      sessions.value = [session, ...sessions.value]
    }
    if (!activeSessionId.value) activeSessionId.value = message.sessionId
    if (message.sessionId === activeSessionId.value) {
      messages.value = upsertPlatformMessage(messages.value, message)
      session.unread = 0
      scrollMessagesToEnd()
    } else if (!message.isMine) {
      session.unread += 1
    }
    session.lastMessage = messages.value.find((item) => item.id === message.id)?.content || message.content || session.lastMessage
    session.updatedAt = message.timestamp
  }
}

onMounted(async () => { disposeEvents = window.platformApi.onEvent(pushEvent); await refresh() })
onUnmounted(() => disposeEvents?.())
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark"><Bot :size="21" /></span><div><strong>平台 Hook 工作台</strong><small>CDP runtime orchestration</small></div></div>
      <div class="top-actions"><span class="runtime-pill"><Activity :size="15" />{{ activePlatform?.label || '未选择平台' }} · {{ unreadCount }} 条未读</span><button class="ghost" @click="importHook"><Download :size="16" />导入 Hook 包</button><button class="ghost" @click="refresh"><RefreshCw :size="16" />刷新</button></div>
    </header>
    <main class="layout">
      <aside class="sidebar">
        <div class="side-title"><span>平台账号</span><button title="添加账号" @click="addAccount"><Plus :size="17" /></button></div>
        <div class="add-box">
          <select v-model="selectedPlatform"><option v-for="platform in platforms" :key="platform.id" :value="platform.id">{{ platform.label }} · {{ platform.source === 'builtin' ? '内置' : '已导入' }}</option></select>
          <input v-model="label" placeholder="账号备注（可选）" @keyup.enter="addAccount" />
          <button class="primary full" :disabled="busy === 'add'" @click="addAccount"><Plus :size="16" />添加并打开页面</button>
        </div>
        <div v-if="!accounts.length" class="empty-side"><Store :size="27" /><span>还没有平台账号</span><small>添加账号后，登录和数据都保存在独立会话中</small></div>
        <div v-for="account in accounts" :key="account.id" role="button" tabindex="0" class="account-item" :class="{ active: account.id === activeAccountId }" @click="openAccount(account)" @keydown.enter="openAccount(account)"><span class="platform-avatar">{{ platforms.find((item) => item.id === account.platform)?.label?.slice(0, 1) || '?' }}</span><span class="account-copy"><strong>{{ account.label }}</strong><small>{{ account.authenticated ? '已登录' : account.connected ? '等待登录' : '未连接' }}</small></span><span :class="['dot', account.connected && account.authenticated ? 'on' : '']" /><button class="delete" title="移除" @click.stop="removeAccount(account)"><Trash2 :size="14" /></button></div>
      </aside>
      <section class="content">
        <div v-if="!activeAccount" class="welcome panel"><div class="welcome-icon"><Bot :size="34" /></div><h1>把平台 Hook 接进一个工作台</h1><p>抖店与快手小店采用 CDP + window runtime，不操作 DOM。需要登录时页面会保持打开，完成登录后采集、回复和监听会自动继续。</p><div class="feature-grid"><div><Wifi :size="19" /><b>CDP 页面会话</b><span>每个账号独立 partition</span></div><div><Boxes :size="19" /><b>商品采集</b><span>列表和详情统一模型</span></div><div><MessageSquare :size="19" /><b>消息监听</b><span>事件流驱动回复</span></div></div></div>
        <template v-else>
          <div class="page-head"><div><div class="eyebrow">{{ activePlatform?.label }} · {{ activeAccount.label }}</div><h1>{{ status?.authenticated ? '已连接，可以开始工作' : '正在等待平台登录' }}</h1><p>{{ status?.message || '页面会话准备中' }}</p></div><div class="status-card" :class="{ ready: status?.authenticated }"><span :class="['status-dot', { ready: status?.authenticated }]" /><div><b>{{ status?.authenticated ? 'Runtime 就绪' : '登录后自动继续' }}</b><small>{{ status?.url }}</small></div></div></div>
          <div class="tabs"><button class="tab active"><MessageSquare :size="16" />消息与回复</button><button class="tab" @click="collect"><Boxes :size="16" />商品采集</button><button class="tab" @click="loadSessions"><RefreshCw :size="16" />刷新会话</button></div>
          <div class="workspace-grid">
            <section class="panel chat-panel"><div class="panel-head"><div><b>会话与消息</b><small>历史和实时消息均来自平台 window runtime</small></div><button class="icon-btn" title="刷新会话" @click="loadSessions"><RefreshCw :size="16" /></button></div><div class="chat-body"><div class="session-list"><button v-for="session in activeSessions" :key="session.id" :class="['session', { selected: session.id === activeSessionId }]" @click="selectSession(session.id)"><span class="session-avatar">{{ session.title.slice(0, 1) }}</span><span><b>{{ session.title }}</b><small>{{ session.lastMessage || '暂无消息' }}</small></span><em v-if="session.unread">{{ session.unread }}</em></button><div v-if="!activeSessions.length" class="empty-box"><MessageSquare :size="25" /><span>点击“刷新会话”读取平台会话</span></div></div><div class="conversation"><div ref="messageList" class="message-list"><div v-for="message in messages" :key="message.id" :class="['message-row', { mine: message.isMine }]"><span class="message-sender">{{ message.isMine ? '我' : message.senderName || '客户' }}</span><div class="message-bubble"><div v-if="message.order" class="message-order"><img v-if="message.order.productImage" :src="message.order.productImage" alt="" /><span v-else class="order-icon"><ReceiptText :size="19" /></span><span><b>{{ message.order.productName || '订单消息' }}</b><small>{{ message.order.status || '订单状态未知' }}<template v-if="message.order.totalAmount != null"> · ¥{{ message.order.totalAmount.toFixed(2) }}</template><template v-if="message.order.quantity != null"> · {{ message.order.quantity }}件</template></small><code>{{ message.order.orderId }}</code></span></div><div v-else-if="message.product" class="message-product"><img v-if="message.product.images?.[0]" :src="message.product.images[0]" alt="" /><span class="image-placeholder" v-else><Boxes :size="18" /></span><span><b>{{ message.product.name }}</b><small>¥{{ message.product.price.toFixed(2) }}<template v-if="message.product.skuList?.[0]?.skuName"> · {{ message.product.skuList[0].skuName }}</template></small><code>{{ message.product.goodsId }}</code></span></div><template v-else>{{ message.content || `[${message.type}]` }}</template></div><time>{{ new Date(message.timestamp).toLocaleTimeString() }}</time></div><div v-if="activeSessionId && !messages.length" class="empty-box"><MessageSquare :size="25" /><span>{{ busy === 'messages' ? '正在读取消息…' : '该会话暂无已加载消息' }}</span></div><div v-if="!activeSessionId" class="empty-box"><MessageSquare :size="25" /><span>选择会话后查看消息</span></div></div><div class="composer"><label class="icon-btn attachment" title="发送图片"><Paperclip :size="17" /><input type="file" accept="image/*" :disabled="!activeSessionId || busy === 'file'" @change="sendImage" /></label><textarea v-model="draft" :disabled="!activeSessionId" placeholder="输入消息" @keydown.ctrl.enter.prevent="send" /><button class="send-btn" :disabled="busy === 'send' || !activeSessionId || !draft.trim()" @click="send"><Send :size="17" />发送</button></div></div></div></section>
            <section class="panel product-panel"><div class="panel-head"><div><b>商品采集</b><small>支持列表、详情和 SKU 统一结果</small></div><button class="outline" :disabled="busy === 'products'" @click="collect"><RefreshCw :size="15" />{{ busy === 'products' ? '登录后继续…' : '开始采集' }}</button></div><div v-if="products.length" class="product-list"><article v-for="product in products" :key="product.id" class="product"><img v-if="product.images?.[0]" :src="product.images[0]" alt="" /><span v-else class="image-placeholder"><Boxes :size="19" /></span><div><b>{{ product.name }}</b><small>¥{{ product.price.toFixed(2) }} · 库存 {{ product.stockQuantity ?? '-' }}</small><code>{{ product.goodsId }}</code></div></article></div><div v-else class="empty-box product-empty"><Boxes :size="29" /><b>还没有采集结果</b><span>登录抖店后点击“开始采集”，任务会自动等待登录完成</span></div></section>
          </div>
          <section class="panel event-panel"><div class="panel-head"><div><b>实时事件</b><small>消息、登录和连接状态都会从 CDP 页面推送到这里</small></div><span class="event-count">{{ logs.length }} / 80</span></div><div class="event-list"><div v-for="event in logs.filter((item) => item.accountId === activeAccountId)" :key="event.id" class="event-row"><span class="event-type">{{ event.type }}</span><span class="event-time">{{ new Date(event.timestamp).toLocaleTimeString() }}</span><code>{{ eventSummary(event) }}</code></div><div v-if="!logs.some((item) => item.accountId === activeAccountId)" class="empty-box">等待页面事件…</div></div></section>
        </template>
      </section>
    </main>
    <Transition name="toast"><div v-if="toast" class="toast"><Settings2 :size="16" />{{ toast }}</div></Transition>
  </div>
</template>
