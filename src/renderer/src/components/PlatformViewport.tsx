import { Activity, Boxes, CheckCircle2, Clock3, MessageSquare, PackageSearch, ReceiptText, RefreshCw, Settings2, Sparkles, Store, Wifi } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ChatSession, HandoffTarget, PlatformAccount, PlatformCapability, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../../shared/platform'
import { AcceptanceCenter } from './AcceptanceCenter'

export interface PlatformViewportProps {
  account?: PlatformAccount
  platform?: PlatformDefinition
  status: PlatformStatus | null
  sessions: ChatSession[]
  messages: PlatformMessage[]
  products: ProductRecord[]
  events: PlatformEvent[]
  busy: string
  selectedSessionId: string
  messageDraft: string
  messageListening: boolean
  orderListening: boolean
  orderWatermark?: number
  handoffTargets: HandoffTarget[]
  selectedHandoffTarget: string
  onRefreshSessions: () => void
  onCollectProducts: () => void
  onSelectSession: (sessionId: string) => void
  onMessageDraftChange: (value: string) => void
  onStartMessages: () => void
  onSendMessage: () => void
  onStartOrders: () => void
  onLoadHandoffTargets: () => void
  onSelectHandoffTarget: (target: string) => void
  onTransfer: () => void
  eventSummary: (event: PlatformEvent) => string
}

export function PlatformViewport(props: PlatformViewportProps) {
  if (!props.account) return <section className="platform-viewport empty-viewport"><div className="viewport-placeholder"><div className="placeholder-icon"><Store size={30} /></div><h1>选择一个店铺开始工作</h1><p>左侧添加平台店铺，工作区会按 manifest 选择网页、原生或服务执行模型。</p><div className="placeholder-points"><span><Wifi size={16} />独立店铺分区</span><span><Activity size={16} />Runtime 运行实例</span><span><Sparkles size={16} />统一能力模型</span></div></div></section>

  const ready = props.status?.authenticated === true
  const supports = (capability: PlatformCapability) => props.platform?.capabilities.includes(capability) === true
  const executionHost = props.platform?.executionModel === 'native' ? 'Native Adapter' : props.platform?.executionModel === 'service' ? 'Service Adapter' : 'Electron BrowserWindow'
  return <section className="platform-viewport">
    <header className="viewport-header"><div><div className="breadcrumb"><span>店铺列表</span><b>/</b><strong>{props.account.label}</strong></div><h1>{props.platform?.label || props.account.platform} 工作台</h1><p>{ready ? 'Hook Runtime 已就绪，可调用消息、商品与订单能力。' : '请在弹出的平台窗口中完成真人登录，登录后能力会自动恢复。'}</p></div><div className={`runtime-status ${ready ? 'ready' : ''}`}><span className="status-light" /><div><strong>{ready ? 'Runtime 就绪' : '等待登录'}</strong><small>{props.status?.message || props.status?.url || '页面会话准备中'}</small></div></div></header>
    <div className="capability-strip"><Capability icon={<MessageSquare size={17} />} label="消息" value={`${props.sessions.length} 个会话`} ready={ready} /><Capability icon={<Boxes size={17} />} label="商品" value={`${props.products.length} 件已采集`} ready={ready} /><Capability icon={<ReceiptText size={17} />} label="订单" value="实时监听" ready={ready} /><Capability icon={<PackageSearch size={17} />} label="执行模型" value={executionHost} ready={Boolean(props.account.connected)} /></div>
    <div className="workspace-panels">
      <section className="workspace-card platform-frame"><div className="card-title"><div><strong>官方消息工作台</strong><span>当前店铺的原生 WebContents 使用该店铺独立 Electron partition。</span></div><span className="frame-pill"><Wifi size={14} />{ready ? '已连接' : '未登录'}</span></div><div className="platform-frame-body"><webview className="platform-workbench" src={props.account.url} partition={props.account.partition} aria-label={`${props.account.label} 官方消息工作台`} /></div></section>
      <section className="workspace-card event-card"><div className="card-title"><div><strong>实时事件</strong><span>来自当前店铺的 Hook 事件流</span></div><span className="event-count">{props.events.length}</span></div><div className="event-stream">{props.events.slice(0, 8).map((event) => <div className="event-item" key={event.id}><span className={`event-badge ${event.type}`}>{event.type}</span><div><strong>{props.eventSummary(event)}</strong><small>{new Date(event.timestamp).toLocaleTimeString()}</small></div></div>)}{!props.events.length && <div className="event-empty"><Clock3 size={22} /><span>等待平台事件…</span></div>}</div></section>
    </div>
    <AcceptanceCenter account={props.account} platform={props.platform} status={props.status} sessions={props.sessions} selectedSessionId={props.selectedSessionId} messages={props.messages} messageDraft={props.messageDraft} messageListening={props.messageListening} products={props.products} orderListening={props.orderListening} orderWatermark={props.orderWatermark} handoffTargets={props.handoffTargets} selectedHandoffTarget={props.selectedHandoffTarget} events={props.events} busy={props.busy} onSelectSession={props.onSelectSession} onMessageDraftChange={props.onMessageDraftChange} onStartMessages={props.onStartMessages} onRefreshSessions={props.onRefreshSessions} onSendMessage={props.onSendMessage} onCollectProducts={props.onCollectProducts} onStartOrders={props.onStartOrders} onLoadHandoffTargets={props.onLoadHandoffTargets} onSelectHandoffTarget={props.onSelectHandoffTarget} onTransfer={props.onTransfer} />
    <section className="workspace-card hook-card"><div className="card-title"><div><strong>平台能力</strong><span>{props.platform?.label || props.account.platform} 适配器按 manifest 声明能力，网页 / 原生 / 服务执行模型均可复用</span></div><button className="outline-button" onClick={props.onRefreshSessions} disabled={props.busy === 'sessions'}><RefreshCw size={14} />刷新会话</button></div><div className="hook-grid"><HookItem icon={<CheckCircle2 size={17} />} label="auth.state" enabled={ready} /><HookItem icon={<MessageSquare size={17} />} label="messages.listen" enabled={ready && supports('messages.listen')} /><HookItem icon={<Boxes size={17} />} label="products.list" enabled={ready && supports('products.collect')} /><HookItem icon={<ReceiptText size={17} />} label="orders.listen" enabled={ready && supports('orders.listen')} /><HookItem icon={<Settings2 size={17} />} label="handoff.transfer" enabled={ready && supports('session.transfer')} /><HookItem icon={<Sparkles size={17} />} label="runtime.events" enabled={Boolean(props.account.connected)} /></div></section>
  </section>
}

function Capability({ icon, label, value, ready }: { icon: ReactNode; label: string; value: string; ready: boolean }) { return <div className="capability"><span className={`capability-icon ${ready ? 'ready' : ''}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong></span></div> }
function FrameStat({ icon, title, value }: { icon: ReactNode; title: string; value: string }) { return <div className="frame-stat"><span>{icon}</span><div><small>{title}</small><strong>{value}</strong></div></div> }
function HookItem({ icon, label, enabled }: { icon: ReactNode; label: string; enabled: boolean }) { return <div className={`hook-item ${enabled ? 'enabled' : ''}`}><span>{icon}</span><code>{label}</code><small>{enabled ? 'ready' : 'waiting'}</small></div> }
