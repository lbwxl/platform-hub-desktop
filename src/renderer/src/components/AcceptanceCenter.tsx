import { AlertCircle, Boxes, CheckCircle2, ClipboardCheck, MessageSquare, Play, ReceiptText, RefreshCw, Send, UserRoundCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ChatSession, HandoffTarget, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus } from '../../../shared/platform'
import { ProductAcceptancePanel } from './ProductAcceptancePanel'
import type { ProductAcceptanceState } from '../productAcceptance'

export interface AcceptanceCenterProps {
  account?: PlatformAccount
  platform?: PlatformDefinition
  status: PlatformStatus | null
  sessions: ChatSession[]
  selectedSessionId: string
  messages: PlatformMessage[]
  messageDraft: string
  messageListening: boolean
  productAcceptance: ProductAcceptanceState
  productSearchQuery: string
  orderListening: boolean
  orderWatermark?: number
  handoffTargets: HandoffTarget[]
  selectedHandoffTarget: string
  events: PlatformEvent[]
  busy: string
  onSelectSession: (sessionId: string) => void
  onMessageDraftChange: (value: string) => void
  onStartMessages: () => void
  onRefreshSessions: () => void
  onSendMessage: () => void
  onCollectProducts: () => void
  onProductSearchQueryChange: (value: string) => void
  onStartOrders: () => void
  onLoadHandoffTargets: () => void
  onSelectHandoffTarget: (target: string) => void
  onTransfer: () => void
}

export function AcceptanceCenter(props: AcceptanceCenterProps) {
  const authenticated = props.status?.authenticated === true
  const platformName = props.platform?.label || props.account?.platform || '当前平台'
  const executionLabel = props.platform?.executionModel === 'native' ? '原生适配器' : props.platform?.executionModel === 'service' ? '服务适配器' : '网页会话'
  const capabilities = new Set(props.platform?.capabilities || [])
  const supportsMessages = capabilities.has('messages.listen') || capabilities.has('messages.history') || capabilities.has('messages.send')
  const supportsSessions = capabilities.has('sessions.list')
  const supportsMessageListen = capabilities.has('messages.listen')
  const supportsMessageHistory = capabilities.has('messages.history')
  const supportsMessageSend = capabilities.has('messages.send')
  const supportsProducts = capabilities.has('products.collect') || capabilities.has('products.detail')
  const supportsProductCollect = capabilities.has('products.collect')
  const supportsOrders = capabilities.has('orders.listen') || capabilities.has('orders.read')
  const supportsOrderListen = capabilities.has('orders.listen')
  const supportsHandoff = capabilities.has('session.transfer')
  const productCards = props.messages.filter((message) => message.type === 'product' || message.type === 'order')
  const orderStatuses = props.events
    .filter((event) => event.type === 'order')
    .map((event) => normalizeOrderStatus(String(((event.payload as { order?: { status?: string } }).order)?.status || 'unknown')))
  const statusSeen = new Set(orderStatuses)

  return <section className="acceptance-center workspace-card">
    <div className="acceptance-heading card-title"><div><strong><ClipboardCheck size={16} />真人验收中心 · {platformName}</strong><span>{executionLabel} · 每一步都由你确认或在平台运行窗口手工完成，结果会实时回填</span></div><span className={`acceptance-login ${authenticated ? 'ready' : ''}`}><span />{authenticated ? '已登录' : '先完成登录'}</span></div>
    <div className="acceptance-grid">
      <AcceptanceCard number="01" icon={<MessageSquare size={18} />} title="消息监听与发送" tone="blue" done={props.messageListening} unsupported={!supportsMessages}>
        <p className="acceptance-help">打开一个会话，点击开始监听；然后发送一条测试文本，观察实时事件和发送结果。</p>
        <div className="acceptance-row"><select value={props.selectedSessionId} onChange={(event) => props.onSelectSession(event.target.value)} disabled={!props.sessions.length || !supportsSessions || !supportsMessageHistory} aria-label="选择验收会话"><option value="">选择会话</option>{props.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select><button className="mini-button" onClick={props.onRefreshSessions} disabled={!supportsSessions || props.busy === 'sessions'}><RefreshCw size={13} />刷新</button></div>
        <div className="acceptance-row"><input value={props.messageDraft} onChange={(event) => props.onMessageDraftChange(event.target.value)} placeholder="输入一条真人验收消息" disabled={!props.selectedSessionId || !supportsMessageSend} /><button className="send-mini" onClick={props.onSendMessage} disabled={!props.selectedSessionId || !props.messageDraft.trim() || props.busy === 'send' || !supportsMessageSend}><Send size={13} />发送</button></div>
        <div className="acceptance-actions"><button className="action-button" onClick={props.onStartMessages} disabled={!authenticated || props.busy === 'messages-listen' || !supportsMessageListen}>{props.messageListening ? <CheckCircle2 size={14} /> : <Play size={14} />}{props.messageListening ? '监听已启动' : '开始监听消息'}</button><span className="result-hint">{productCards.length ? `已识别 ${productCards.length} 条卡片消息` : '商品卡片消息将在这里标记'}</span></div>
        {!supportsMessages ? <UnsupportedMessage /> : <><div className="message-check-list">{props.messages.slice(-4).map((message) => <div className="message-check-item" key={message.id}><span className={`message-check-type ${message.isMine ? 'mine' : ''}`}>{message.isMine ? '我' : message.senderName || '客户'}</span><span>{message.content || `[${message.type}]`}</span><span className={`message-origin ${message.origin || 'unknown'}`}>{messageOriginLabel(message)}</span><time>{new Date(message.timestamp).toLocaleTimeString()}</time></div>)}{!props.messages.length && <span className="muted-line">监听启动后，最新消息会显示在这里…</span>}</div><div className="recognition-list">{productCards.slice(-3).map((message) => <div className="recognition-item" key={message.id}><span className={`recognition-tag ${message.type}`}>{message.type === 'product' ? '商品卡片' : '订单卡片'}</span><span>{message.content || '已识别结构化卡片'}</span></div>)}{!productCards.length && <span className="muted-line">等待客户发送商品/订单卡片…</span>}</div></>}
      </AcceptanceCard>

      <AcceptanceCard number="02" icon={<Boxes size={18} />} title="商品全量同步" tone="purple" done={props.productAcceptance.syncState === 'success'} unsupported={!supportsProducts}>
        <ProductAcceptancePanel state={props.productAcceptance} authenticated={authenticated} supportsProducts={supportsProducts} supportsProductCollect={supportsProductCollect} busy={props.busy} searchQuery={props.productSearchQuery} onSearchQueryChange={props.onProductSearchQueryChange} onCollectProducts={props.onCollectProducts} />
      </AcceptanceCard>

      <AcceptanceCard number="03" icon={<ReceiptText size={18} />} title="订单变化监听" tone="orange" done={props.orderListening && orderStatuses.length > 0} unsupported={!supportsOrders}>
        <p className="acceptance-help">先点击启动监听，再按提示在真实店铺完成下单、支付、退款。不要把历史快照当作新订单。</p>
        <div className="acceptance-actions"><button className="action-button orange" onClick={props.onStartOrders} disabled={!authenticated || props.busy === 'orders-listen' || !supportsOrderListen}>{props.orderListening ? <CheckCircle2 size={14} /> : <Play size={14} />}{props.orderListening ? '订单监听中' : '启动订单监听'}</button><span className="result-hint">{props.orderWatermark ? `水位 ${new Date(props.orderWatermark).toLocaleTimeString()}` : '等待建立快照水位'}</span></div>
        {supportsOrders ? <div className="order-checklist"><StatusCheck label="ORDER_CREATED" active={statusSeen.has('created')} /><StatusCheck label="ORDER_PAID" active={statusSeen.has('paid')} /><StatusCheck label="ORDER_REFUNDING" active={statusSeen.has('refunding')} /><StatusCheck label="ORDER_REFUNDED" active={statusSeen.has('refunded')} /></div> : <UnsupportedMessage />}
      </AcceptanceCard>

      <AcceptanceCard number="04" icon={<UserRoundCheck size={18} />} title="转人工" tone="green" done={props.handoffTargets.length > 0} unsupported={!supportsHandoff}>
        <p className="acceptance-help">先读取平台官方可转目标，再选择客服或客服组，将当前验收会话转交给目标。</p>
        <div className="acceptance-row"><select value={props.selectedHandoffTarget} onChange={(event) => props.onSelectHandoffTarget(event.target.value)} disabled={!props.handoffTargets.length || !supportsHandoff} aria-label="选择转人工目标"><option value="">选择目标</option>{props.handoffTargets.map((target) => <option key={target.id || target.name} value={target.id || target.name}>{target.name}</option>)}</select><button className="mini-button" onClick={props.onLoadHandoffTargets} disabled={!authenticated || props.busy === 'handoff-targets' || !supportsHandoff}><RefreshCw size={13} />读取</button></div>
        <div className="acceptance-actions"><button className="action-button green" onClick={props.onTransfer} disabled={!props.selectedSessionId || !props.selectedHandoffTarget || props.busy === 'handoff-transfer' || !supportsHandoff}><UserRoundCheck size={14} />转交当前会话</button><span className="result-hint">{props.handoffTargets.length ? `${props.handoffTargets.length} 个官方目标` : '尚未读取目标'}</span></div>
        {supportsHandoff ? (!props.handoffTargets.length && <span className="muted-line">需要登录并存在可转人工目标…</span>) : <UnsupportedMessage />}
      </AcceptanceCard>
    </div>
    {!props.account && <div className="acceptance-blocked"><AlertCircle size={16} />请先添加并打开平台店铺</div>}
  </section>
}

function AcceptanceCard({ number, icon, title, tone, done, unsupported, children }: { number: string; icon: ReactNode; title: string; tone: string; done: boolean; unsupported?: boolean; children: ReactNode }) {
  return <article className={`acceptance-card ${tone} ${unsupported ? 'unsupported' : ''}`}><div className="acceptance-card-title"><span className="acceptance-number">{number}</span><span className="acceptance-icon">{icon}</span><strong>{title}</strong>{unsupported && <span className="acceptance-support-label">未声明</span>}{done && !unsupported && <CheckCircle2 className="acceptance-done" size={16} />}</div>{children}</article>
}

function StatusCheck({ label, active }: { label: string; active: boolean }) { return <div className={`order-status-check ${active ? 'active' : ''}`}><span>{active ? <CheckCircle2 size={13} /> : <span className="status-empty" />}</span><code>{label}</code></div> }

function UnsupportedMessage() { return <div className="acceptance-unavailable"><AlertCircle size={14} />当前平台未声明这项能力，验收入口会在对应 Adapter 接入后启用。</div> }

function normalizeOrderStatus(value: string): string {
  const status = value.toLowerCase().replace(/^order_/, '')
  if (status.includes('refund') && (status.includes('success') || status.includes('complete') || status.includes('refunded'))) return 'refunded'
  if (status.includes('refund')) return 'refunding'
  if (status.includes('paid') || status.includes('pay')) return 'paid'
  if (status.includes('created') || status.includes('pending') || status.includes('new')) return 'created'
  return status
}

function messageOriginLabel(message: PlatformMessage): string {
  if (message.origin === 'human') return '人工手动'
  if (message.origin === 'automation') return 'Hook 自动'
  if (message.origin === 'system') return '平台系统'
  if (message.origin === 'customer') return '买家'
  return '来源未知'
}
