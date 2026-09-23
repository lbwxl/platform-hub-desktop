import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Activity, Bell, RefreshCw, Settings2 } from 'lucide-react'
import type { ChatSession, HandoffTarget, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformRuntimeSnapshot, PlatformStatus, ProductRecord } from '../../shared/platform'
import { upsertPlatformMessage } from '../../shared/messageMerge'
import { PlatformViewport } from './components/PlatformViewport'
import { StoreSidebar } from './components/StoreSidebar'
import { RuntimeStatusPanel } from './components/RuntimeStatusPanel'

export default function App() {
  const [platforms, setPlatforms] = useState<PlatformDefinition[]>([])
  const [accounts, setAccounts] = useState<PlatformAccount[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState('douyin-shop')
  const [label, setLabel] = useState('')
  const [productsByAccount, setProductsByAccount] = useState<Record<string, ProductRecord[]>>({})
  const [sessionsByAccount, setSessionsByAccount] = useState<Record<string, ChatSession[]>>({})
  const [selectedSessionByAccount, setSelectedSessionByAccount] = useState<Record<string, string>>({})
  const [messagesByAccount, setMessagesByAccount] = useState<Record<string, PlatformMessage[]>>({})
  const [messageDraftByAccount, setMessageDraftByAccount] = useState<Record<string, string>>({})
  const [messageListeningByAccount, setMessageListeningByAccount] = useState<Record<string, boolean>>({})
  const [orderListeningByAccount, setOrderListeningByAccount] = useState<Record<string, boolean>>({})
  const [orderWatermarkByAccount, setOrderWatermarkByAccount] = useState<Record<string, number | undefined>>({})
  const [handoffTargetsByAccount, setHandoffTargetsByAccount] = useState<Record<string, HandoffTarget[]>>({})
  const [selectedHandoffByAccount, setSelectedHandoffByAccount] = useState<Record<string, string>>({})
  const [statusByAccount, setStatusByAccount] = useState<Record<string, PlatformStatus | null>>({})
  const [runtimeSnapshotByAccount, setRuntimeSnapshotByAccount] = useState<Record<string, PlatformRuntimeSnapshot>>({})
  const [events, setEvents] = useState<PlatformEvent[]>([])
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const reportViewportBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    void window.platformApi.setPrimaryViewportBounds(bounds)
  }, [])

  const activeAccount = useMemo(() => accounts.find((item) => item.id === activeAccountId), [accounts, activeAccountId])
  const activePlatform = useMemo(() => platforms.find((item) => item.id === (activeAccount?.platform || selectedPlatform)), [platforms, activeAccount, selectedPlatform])
  const sessions = sessionsByAccount[activeAccountId] || []
  const messages = messagesByAccount[activeAccountId] || []
  const products = productsByAccount[activeAccountId] || []
  const selectedSessionId = selectedSessionByAccount[activeAccountId] || ''
  const messageDraft = messageDraftByAccount[activeAccountId] || ''
  const messageListening = messageListeningByAccount[activeAccountId] || false
  const orderListening = orderListeningByAccount[activeAccountId] || false
  const orderWatermark = orderWatermarkByAccount[activeAccountId]
  const handoffTargets = handoffTargetsByAccount[activeAccountId] || []
  const selectedHandoffTarget = selectedHandoffByAccount[activeAccountId] || ''
  const status = statusByAccount[activeAccountId] || null

  const updateMap = useCallback(<T,>(setter: Dispatch<SetStateAction<Record<string, T>>>, accountId: string, value: NoInfer<T> | ((current: T | undefined) => T)) => {
    setter((current) => ({ ...current, [accountId]: typeof value === 'function' ? (value as (current: T | undefined) => T)(current[accountId]) : value }))
  }, [])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 2800)
  }, [])

  const inspect = useCallback(async (accountId: string) => {
    try {
      const nextStatus = await window.platformApi.status(accountId)
      updateMap(setStatusByAccount, accountId, nextStatus)
      setAccounts((current) => current.map((item) => item.id === accountId ? { ...item, connected: nextStatus.connected, authenticated: nextStatus.authenticated } : item))
    } catch (error) { notify(errorMessage(error)) }
  }, [notify, updateMap])

  const loadMessages = useCallback(async (accountId: string, sessionId: string) => {
    try {
      const result = await window.platformApi.messages(accountId, sessionId)
      if (!Array.isArray(result)) throw new Error(operationError(result) || '平台未返回消息列表')
      updateMap(setMessagesByAccount, accountId, result)
    } catch (error) { notify(errorMessage(error)) }
  }, [notify, updateMap])

  const refreshSessions = useCallback(async (accountId = activeAccountId) => {
    if (!accountId) return
    setBusy('sessions')
    try {
      const result = await window.platformApi.sessions(accountId)
      if (!Array.isArray(result)) throw new Error(operationError(result) || '平台未返回会话列表')
      const nextSessions = result
      updateMap(setSessionsByAccount, accountId, nextSessions)
      const nextSessionId = nextSessions[0]?.id || ''
      updateMap(setSelectedSessionByAccount, accountId, nextSessionId)
      if (nextSessionId) await loadMessages(accountId, nextSessionId)
      else updateMap(setMessagesByAccount, accountId, [])
      notify(`已读取 ${nextSessions.length} 个会话`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, loadMessages, notify, updateMap])

  const refresh = useCallback(async () => {
    try {
      const [nextPlatforms, nextAccounts, runtimeStates] = await Promise.all([window.platformApi.platforms.list(), window.platformApi.accounts.list(), window.platformApi.runtimeStates()])
      setPlatforms(nextPlatforms); setAccounts(nextAccounts)
      setRuntimeSnapshotByAccount(Object.fromEntries(runtimeStates.map((runtime) => [runtime.accountId, runtime])))
      const accountId = activeAccountId && nextAccounts.some((item) => item.id === activeAccountId) ? activeAccountId : nextAccounts[0]?.id || ''
      setActiveAccountId(accountId)
      if (accountId) { await inspect(accountId); await refreshSessions(accountId) }
    } catch (error) { notify(errorMessage(error)) }
  }, [activeAccountId, inspect, notify, refreshSessions])

  const addAccount = useCallback(async () => {
    setBusy('add')
    try {
      const account = await window.platformApi.accounts.add({ platform: selectedPlatform, label: label || activePlatform?.label || '平台店铺' })
      setLabel(''); setAccounts((current) => [...current, account]); setActiveAccountId(account.id)
      await window.platformApi.accounts.open(account.id); await inspect(account.id)
      notify('店铺已打开，请在当前工作台中完成登录')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activePlatform, inspect, label, notify, selectedPlatform])

  const openAccount = useCallback(async (account: PlatformAccount) => {
    setActiveAccountId(account.id); setBusy(`open:${account.id}`)
    try { await window.platformApi.accounts.open(account.id); await inspect(account.id); notify('当前店铺工作台已切换，Hook 正在等待登录') } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [inspect, notify])

  const removeAccount = useCallback(async (account: PlatformAccount) => {
    if (!window.confirm(`确定移除“${account.label}”吗？`)) return
    try { await window.platformApi.accounts.remove(account.id); await refresh(); notify('店铺已移除') } catch (error) { notify(errorMessage(error)) }
  }, [notify, refresh])

  const importHook = useCallback(async () => {
    try { const imported = await window.platformApi.platforms.importPackage(); if (imported) { await refresh(); setSelectedPlatform(imported.id); notify(`已导入 ${imported.label} Hook 包`) } } catch (error) { notify(errorMessage(error)) }
  }, [notify, refresh])

  const collectProducts = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('products')
    try {
      const result = await window.platformApi.collectProducts(activeAccountId)
      if (!Array.isArray(result)) throw new Error(operationError(result) || '平台未返回商品列表')
      updateMap(setProductsByAccount, activeAccountId, result)
      notify('商品采集完成')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify, updateMap])

  const selectSession = useCallback((sessionId: string) => {
    updateMap(setSelectedSessionByAccount, activeAccountId, sessionId)
    if (activeAccountId && sessionId) void loadMessages(activeAccountId, sessionId)
  }, [activeAccountId, loadMessages, updateMap])

  const startMessageListening = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('messages-listen')
    try {
      const result = await window.platformApi.listenMessages(activeAccountId)
      const failure = operationError(result)
      if (failure) throw new Error(failure)
      updateMap(setMessageListeningByAccount, activeAccountId, result.listening === true)
      notify(result.listening ? '消息监听已启动，等待客户消息或商品卡片' : '平台未返回消息监听状态')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify, updateMap])

  const sendTestMessage = useCallback(async () => {
    if (!activeAccountId || !selectedSessionId || !messageDraft.trim()) return
    setBusy('send')
    try {
      const result = await window.platformApi.sendMessage(activeAccountId, selectedSessionId, messageDraft.trim())
      if (!result.success) throw new Error(result.error || '消息发送失败')
      const sent = messageDraft.trim()
      updateMap(setMessageDraftByAccount, activeAccountId, '')
      await loadMessages(activeAccountId, selectedSessionId)
      notify(`测试消息已发送：${sent.slice(0, 24)}`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, loadMessages, messageDraft, notify, selectedSessionId, updateMap])

  const startOrderListening = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('orders-listen')
    try {
      // Pass the selected session when available so platforms that resolve orders
      // through the buyer conversation can establish an authoritative watermark.
      const result = await window.platformApi.listenOrders(activeAccountId, selectedSessionId || undefined)
      const failure = operationError(result)
      if (failure) throw new Error(failure)
      updateMap(setOrderListeningByAccount, activeAccountId, result.listening === true)
      updateMap(setOrderWatermarkByAccount, activeAccountId, result.watermark)
      notify(result.listening ? '订单监听已启动，请按验收清单操作真实订单' : '平台未返回订单监听状态')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify, selectedSessionId, updateMap])

  const loadHandoffTargets = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('handoff-targets')
    try {
      const targets = await window.platformApi.handoffTargets(activeAccountId)
      if (!Array.isArray(targets)) throw new Error(operationError(targets) || '平台未返回可转人工目标')
      updateMap(setHandoffTargetsByAccount, activeAccountId, targets)
      updateMap(setSelectedHandoffByAccount, activeAccountId, '')
      notify(targets.length ? `已读取 ${targets.length} 个官方转人工目标` : '当前平台没有可转人工目标')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify, updateMap])

  const transferSession = useCallback(async () => {
    if (!activeAccountId || !selectedSessionId || !selectedHandoffTarget) return
    const target = handoffTargets.find((item) => (item.id || item.name) === selectedHandoffTarget)
    if (!window.confirm(`确认将当前会话转交给“${target?.name || selectedHandoffTarget}”吗？`)) return
    setBusy('handoff-transfer')
    try {
      const result = await window.platformApi.transferSession(activeAccountId, selectedSessionId, selectedHandoffTarget)
      const failure = operationError(result)
      if (failure) throw new Error(failure)
      notify(`已将会话转交给 ${target?.name || selectedHandoffTarget}`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, handoffTargets, notify, selectedHandoffTarget, selectedSessionId])

  const setOnline = useCallback(async (account: PlatformAccount, online: boolean) => {
    setBusy(`online:${account.id}`)
    try {
      const next = await window.platformApi.accounts.setOnline(account.id, online)
      setAccounts((current) => current.map((item) => item.id === next.id ? next : item))
      updateMap(setRuntimeSnapshotByAccount, account.id, (current) => ({
        accountId: account.id,
        online: next.online,
        runtimeState: next.runtimeState,
        messageListening: next.messageListening === true,
        attention: current?.attention || {},
        ...(current?.lastIncomingAt ? { lastIncomingAt: current.lastIncomingAt } : {}),
        ...(current?.lastReplyAt ? { lastReplyAt: current.lastReplyAt } : {}),
        ...(current?.lastReplyType ? { lastReplyType: current.lastReplyType } : {}),
      }))
      notify(`${account.label} 已${online ? '上线' : '下线'}`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [notify, updateMap])

  const eventSummary = useCallback((event: PlatformEvent) => {
    if (!event.payload || typeof event.payload !== 'object') return String(event.payload || event.type)
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'order') {
      const order = (payload.order as Record<string, unknown> | undefined) || {}
      const status = String(order.status || '状态变化')
      const orderId = String(order.orderId || order.id || '').replace(/^douyin:[^:]+:/, '')
      const eventType = String(payload.eventType || '').replace(/^order\./, '')
      return `订单事件 · ${eventType ? `${eventType} · ` : ''}${status}${orderId ? ` · ${orderId}` : ''}`
    }
    if (event.type === 'message') {
      const message = (payload.message as Record<string, unknown> | undefined) || payload
      return `收到消息 · ${String(message.content || '新消息')}`
    }
    return `${event.type} · ${String(payload.message || payload.connected || payload.authenticated || '')}`
  }, [])

  useEffect(() => {
    const dispose = window.platformApi.onEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 80))
      if (event.type === 'connection') {
        const nextStatus = event.payload as PlatformStatus
        updateMap(setStatusByAccount, event.accountId, nextStatus)
        setAccounts((current) => current.map((item) => item.id === event.accountId ? { ...item, connected: nextStatus.connected, authenticated: nextStatus.authenticated } : item))
        if (!nextStatus.authenticated) {
          updateMap(setMessageListeningByAccount, event.accountId, false)
          updateMap(setOrderListeningByAccount, event.accountId, false)
          updateMap(setOrderWatermarkByAccount, event.accountId, undefined)
          updateMap(setHandoffTargetsByAccount, event.accountId, [])
          updateMap(setSelectedHandoffByAccount, event.accountId, '')
        }
      }
      if (event.type === 'log' && event.payload && typeof event.payload === 'object') {
        const payload = event.payload as Record<string, unknown>
        const runtime = payload as { runtimeState?: PlatformAccount['runtimeState']; online?: boolean; messageListening?: boolean }
        const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision as { type?: unknown } : undefined
        const replyType = decision?.type === 'reply' || decision?.type === 'human_required' || decision?.type === 'ignore'
          ? decision.type as PlatformRuntimeSnapshot['lastReplyType']
          : undefined
        const attentionState = typeof payload.state === 'string' && ['pending', 'opened', 'resolved'].includes(payload.state)
          ? payload.state as PlatformRuntimeSnapshot['attention'][string]
          : undefined
        const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : undefined
        updateMap(setRuntimeSnapshotByAccount, event.accountId, (current) => {
          const attention = { ...(current?.attention || {}) }
          if (conversationId && attentionState) attention[conversationId] = attentionState
          return {
            accountId: event.accountId,
            online: typeof runtime.online === 'boolean' ? runtime.online : current?.online || false,
            runtimeState: runtime.runtimeState || current?.runtimeState || 'stopped',
            messageListening: typeof runtime.messageListening === 'boolean' ? runtime.messageListening : current?.messageListening || false,
            attention,
            ...(replyType
              ? { lastReplyAt: event.timestamp, lastReplyType: replyType }
              : current?.lastReplyAt ? { lastReplyAt: current.lastReplyAt, ...(current.lastReplyType ? { lastReplyType: current.lastReplyType } : {}) } : {}),
            ...(current?.lastIncomingAt ? { lastIncomingAt: current.lastIncomingAt } : {}),
          }
        })
        if (runtime.runtimeState) {
          setAccounts((current) => current.map((item) => item.id === event.accountId
            ? { ...item, runtimeState: runtime.runtimeState!, ...(typeof runtime.online === 'boolean' ? { online: runtime.online } : {}), ...(typeof runtime.messageListening === 'boolean' ? { messageListening: runtime.messageListening } : {}) }
            : item))
        }
        if (typeof runtime.messageListening === 'boolean') updateMap(setMessageListeningByAccount, event.accountId, runtime.messageListening)
      }
      if (event.type === 'message') {
        const message = extractMessage(event.payload)
        if (!message) return
        updateMap(setRuntimeSnapshotByAccount, event.accountId, (current) => ({
          accountId: event.accountId,
          online: current?.online || false,
          runtimeState: current?.runtimeState || 'stopped',
          messageListening: current?.messageListening || false,
          attention: current?.attention || {},
          ...(current?.lastReplyAt ? { lastReplyAt: current.lastReplyAt } : {}),
          ...(current?.lastReplyType ? { lastReplyType: current.lastReplyType } : {}),
          lastIncomingAt: event.timestamp,
        }))
        updateMap(setMessagesByAccount, event.accountId, (current) => upsertPlatformMessage(current || [], message))
        updateMap(setSessionsByAccount, event.accountId, (current) => (current || []).some((item) => item.id === message.sessionId) ? current || [] : [{ id: message.sessionId, title: message.senderName || '新会话', unread: 0 }, ...(current || [])])
      }
    })
    void refresh()
    return dispose
  }, [activeAccountId, refresh, updateMap])

  return <div className="app-shell">
    <header className="app-topbar"><div className="topbar-title"><span className="topbar-mark"><Activity size={18} /></span><div><strong>平台工作台</strong><small>统一管理店铺、消息、商品与订单</small></div></div><div className="topbar-actions"><span className="topbar-live"><span className="live-dot" />{activeAccount ? `${activePlatform?.label || activeAccount.platform} · ${activeAccount.label}` : '未选择店铺'}</span><button className="topbar-button" onClick={() => void refresh()}><RefreshCw size={15} />刷新</button><button className="topbar-icon" title="通知"><Bell size={17} /></button><button className="topbar-icon" title="设置"><Settings2 size={17} /></button></div></header>
    <main className="app-layout"><StoreSidebar platforms={platforms} accounts={accounts} activeAccountId={activeAccountId} selectedPlatform={selectedPlatform} label={label} busy={busy} onPlatformChange={setSelectedPlatform} onLabelChange={setLabel} onAdd={() => void addAccount()} onSelect={(account) => void openAccount(account)} onSetOnline={(account, online) => void setOnline(account, online)} onRemove={(account) => void removeAccount(account)} onImport={() => void importHook()} /><PlatformViewport account={activeAccount} platform={activePlatform} status={status} sessions={sessions} messages={messages} products={products} events={events.filter((item) => item.accountId === activeAccountId)} busy={busy} selectedSessionId={selectedSessionId} messageDraft={messageDraft} messageListening={messageListening} orderListening={orderListening} orderWatermark={orderWatermark} handoffTargets={handoffTargets} selectedHandoffTarget={selectedHandoffTarget} onRefreshSessions={() => void refreshSessions()} onCollectProducts={() => void collectProducts()} onSelectSession={selectSession} onMessageDraftChange={(value) => updateMap(setMessageDraftByAccount, activeAccountId, value)} onStartMessages={() => void startMessageListening()} onSendMessage={() => void sendTestMessage()} onStartOrders={() => void startOrderListening()} onLoadHandoffTargets={() => void loadHandoffTargets()} onSelectHandoffTarget={(value) => updateMap(setSelectedHandoffByAccount, activeAccountId, value)} onTransfer={() => void transferSession()} eventSummary={eventSummary} onViewportBounds={reportViewportBounds} /><RuntimeStatusPanel account={activeAccount} platform={activePlatform} status={status} runtime={runtimeSnapshotByAccount[activeAccountId]} sessionCount={sessions.length} productCount={products.length} messageListening={messageListening} orderListening={orderListening} recentMessage={messages.slice().reverse().find((message) => message.direction === 'inbound' || !message.isMine)?.content} /></main>
    {toast && <div className="toast"><Activity size={15} />{toast}</div>}
  </div>
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function operationError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { errorCode?: unknown; error?: unknown; success?: unknown }
  if (record.errorCode || record.success === false) return String(record.error || record.errorCode || '平台操作失败')
  return undefined
}

function extractMessage(value: unknown): PlatformMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { message?: unknown; payload?: unknown }
  const candidate = record.message && typeof record.message === 'object' ? record.message : record.payload && typeof record.payload === 'object' ? record.payload : value
  if (!candidate || typeof candidate !== 'object') return null
  const message = candidate as Partial<PlatformMessage>
  if (!message.id || !message.sessionId) return null
  return message as PlatformMessage
}
