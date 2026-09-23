import { Activity, Bot, MessageSquare, PackageSearch, Power, ReceiptText, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PlatformAccount, PlatformDefinition, PlatformRuntimeSnapshot, PlatformStatus } from '../../../shared/platform'

export interface RuntimeStatusPanelProps {
  account?: PlatformAccount
  platform?: PlatformDefinition
  status: PlatformStatus | null
  runtime?: PlatformRuntimeSnapshot
  sessionCount: number
  productCount: number
  messageListening: boolean
  orderListening: boolean
  recentMessage?: string
}

export function RuntimeStatusPanel(props: RuntimeStatusPanelProps) {
  if (!props.account) return <aside className="runtime-side-panel empty-runtime-panel" />
  const ready = props.status?.authenticated === true
  const runtimeState = props.runtime?.runtimeState || props.account.runtimeState
  const listening = props.runtime?.messageListening || props.messageListening
  const attentionEntries = Object.entries(props.runtime?.attention || {}).filter(([, state]) => state !== 'resolved')
  const lastReply = props.runtime?.lastReplyType || '—'
  return <aside className="runtime-side-panel">
    <div className="runtime-side-heading"><div><small>AICHAT STATUS</small><strong>{props.account.label}</strong></div><span className={`runtime-side-dot ${props.account.online ? 'online' : ''}`} /></div>
    <div className="runtime-side-account"><span className="runtime-side-avatar"><UserRound size={18} /></span><div><strong>{props.platform?.label || props.account.platform}</strong><small>{ready ? '已登录 · 当前店铺' : '等待登录'}</small></div></div>
    <StatusRow icon={<Power size={15} />} label="AI 在线" value={props.account.online ? 'ON' : 'OFF'} tone={props.account.online ? 'good' : 'muted'} />
    <StatusRow icon={<Activity size={15} />} label="Runtime" value={runtimeState} tone={runtimeState === 'running' ? 'good' : 'muted'} />
    <StatusRow icon={<MessageSquare size={15} />} label="消息监听" value={listening ? '监听中' : '未启动'} tone={listening ? 'good' : 'muted'} />
    <StatusRow icon={<Bot size={15} />} label="最近 Reply" value={lastReply} tone={props.runtime?.lastReplyType === 'reply' ? 'good' : 'muted'} />
    <StatusRow icon={<UserRound size={15} />} label="Attention" value={attentionEntries.length ? `${attentionEntries.length} 个会话` : '无'} tone={attentionEntries.length ? 'good' : 'muted'} />
    <div className="runtime-side-recent"><small>最近入站消息</small><span>{props.recentMessage || '等待客户消息…'}</span></div>
    <div className="runtime-side-divider" />
    <div className="runtime-side-section"><small>CAPABILITIES</small><Metric icon={<MessageSquare size={14} />} label="会话" value={String(props.sessionCount)} /><Metric icon={<PackageSearch size={14} />} label="商品同步" value={String(props.productCount)} /><Metric icon={<ReceiptText size={14} />} label="订单监听" value={props.orderListening ? 'ON' : 'OFF'} /></div>
    <div className="runtime-side-footer">{props.runtime?.lastIncomingAt ? `最近入站 ${new Date(props.runtime.lastIncomingAt).toLocaleTimeString()}` : props.status?.message || 'Runtime 状态由 Main Process 管理'}</div>
  </aside>
}

function StatusRow(props: { icon: ReactNode; label: string; value: string; tone: 'good' | 'muted' }) {
  return <div className="runtime-status-row"><span className={`runtime-row-icon ${props.tone}`}>{props.icon}</span><span>{props.label}</span><strong className={props.tone}>{props.value}</strong></div>
}

function Metric(props: { icon: ReactNode; label: string; value: string }) { return <div className="runtime-metric"><span>{props.icon}</span><small>{props.label}</small><strong>{props.value}</strong></div> }
