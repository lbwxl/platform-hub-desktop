import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Bell, RefreshCw, Settings2 } from 'lucide-react'
import type { ChatSession, HandoffTarget, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
import { upsertPlatformMessage } from '../../shared/messageMerge'
import { PlatformViewport } from './components/PlatformViewport'
import { StoreSidebar } from './components/StoreSidebar'

export default function App() {
  const [platforms, setPlatforms] = useState<PlatformDefinition[]>([])
  const [accounts, setAccounts] = useState<PlatformAccount[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState('douyin-shop')
  const [label, setLabel] = useState('')
  const [products, setProducts] = useState<ProductRecord[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [messages, setMessages] = useState<PlatformMessage[]>([])
  const [messageDraft, setMessageDraft] = useState('')
  const [messageListening, setMessageListening] = useState(false)
  const [orderListening, setOrderListening] = useState(false)
  const [orderWatermark, setOrderWatermark] = useState<number>()
  const [handoffTargets, setHandoffTargets] = useState<HandoffTarget[]>([])
  const [selectedHandoffTarget, setSelectedHandoffTarget] = useState('')
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [events, setEvents] = useState<PlatformEvent[]>([])
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')

  const activeAccount = useMemo(() => accounts.find((item) => item.id === activeAccountId), [accounts, activeAccountId])
  const activePlatform = useMemo(() => platforms.find((item) => item.id === (activeAccount?.platform || selectedPlatform)), [platforms, activeAccount, selectedPlatform])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 2800)
  }, [])

  const inspect = useCallback(async (accountId: string) => {
    try {
      const nextStatus = await window.platformApi.status(accountId)
      setStatus(nextStatus)
      setAccounts((current) => current.map((item) => item.id === accountId ? { ...item, connected: nextStatus.connected, authenticated: nextStatus.authenticated } : item))
    } catch (error) { notify(errorMessage(error)) }
  }, [notify])

  const loadMessages = useCallback(async (accountId: string, sessionId: string) => {
    try {
      const result = await window.platformApi.messages(accountId, sessionId)
      if (!Array.isArray(result)) throw new Error(operationError(result) || '平台未返回消息列表')
      setMessages(result)
    } catch (error) { notify(errorMessage(error)) }
  }, [notify])

  const refreshSessions = useCallback(async (accountId = activeAccountId) => {
    if (!accountId) return
    setBusy('sessions')
    try {
      const result = await window.platformApi.sessions(accountId)
      if (!Array.isArray(result)) throw new Error(operationError(result) || '平台未返回会话列表')
      const nextSessions = result
      setSessions(nextSessions)
      const nextSessionId = nextSessions[0]?.id || ''
      setSelectedSessionId(nextSessionId)
      if (nextSessionId) await loadMessages(accountId, nextSessionId)
      else setMessages([])
      notify(`已读取 ${nextSessions.length} 个会话`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, loadMessages, notify])

  const resetAccountView = useCallback(() => {
    setStatus(null)
    setProducts([])
    setSessions([])
    setSelectedSessionId('')
    setMessages([])
    setMessageDraft('')
    setMessageListening(false)
    setOrderListening(false)
    setOrderWatermark(undefined)
    setHandoffTargets([])
    setSelectedHandoffTarget('')
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [nextPlatforms, nextAccounts] = await Promise.all([window.platformApi.platforms.list(), window.platformApi.accounts.list()])
      setPlatforms(nextPlatforms); setAccounts(nextAccounts)
      const accountId = activeAccountId && nextAccounts.some((item) => item.id === activeAccountId) ? activeAccountId : nextAccounts[0]?.id || ''
      if (accountId !== activeAccountId) resetAccountView()
      setActiveAccountId(accountId)
      if (accountId) { await inspect(accountId); await refreshSessions(accountId) }
    } catch (error) { notify(errorMessage(error)) }
  }, [activeAccountId, inspect, notify, refreshSessions, resetAccountView])

  const addAccount = useCallback(async () => {
    setBusy('add')
    try {
      const account = await window.platformApi.accounts.add({ platform: selectedPlatform, label: label || activePlatform?.label || '平台店铺' })
      setLabel(''); setAccounts((current) => [...current, account]); resetAccountView(); setActiveAccountId(account.id)
      await window.platformApi.accounts.open(account.id); await inspect(account.id)
      notify('店铺已打开，请在 Electron 平台窗口中完成登录')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activePlatform, inspect, label, notify, resetAccountView, selectedPlatform])

  const openAccount = useCallback(async (account: PlatformAccount) => {
    if (account.id !== activeAccountId) resetAccountView()
    setActiveAccountId(account.id); setBusy(`open:${account.id}`)
    try { await window.platformApi.accounts.open(account.id); await inspect(account.id); notify('平台窗口已打开，Hook 正在等待登录') } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, inspect, notify, resetAccountView])

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
      setProducts(result)
      notify('商品采集完成')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify])

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId)
    if (activeAccountId && sessionId) void loadMessages(activeAccountId, sessionId)
  }, [activeAccountId, loadMessages])

  const startMessageListening = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('messages-listen')
    try {
      const result = await window.platformApi.listenMessages(activeAccountId)
      const failure = operationError(result)
      if (failure) throw new Error(failure)
      setMessageListening(result.listening === true)
      notify(result.listening ? '消息监听已启动，等待客户消息或商品卡片' : '平台未返回消息监听状态')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify])

  const sendTestMessage = useCallback(async () => {
    if (!activeAccountId || !selectedSessionId || !messageDraft.trim()) return
    setBusy('send')
    try {
      const result = await window.platformApi.sendMessage(activeAccountId, selectedSessionId, messageDraft.trim())
      if (!result.success) throw new Error(result.error || '消息发送失败')
      const sent = messageDraft.trim()
      setMessageDraft('')
      await loadMessages(activeAccountId, selectedSessionId)
      notify(`测试消息已发送：${sent.slice(0, 24)}`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, loadMessages, messageDraft, notify, selectedSessionId])

  const startOrderListening = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('orders-listen')
    try {
      // Pass the selected session when available so platforms that resolve orders
      // through the buyer conversation can establish an authoritative watermark.
      const result = await window.platformApi.listenOrders(activeAccountId, selectedSessionId || undefined)
      const failure = operationError(result)
      if (failure) throw new Error(failure)
      setOrderListening(result.listening === true)
      setOrderWatermark(result.watermark)
      notify(result.listening ? '订单监听已启动，请按验收清单操作真实订单' : '平台未返回订单监听状态')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify, selectedSessionId])

  const loadHandoffTargets = useCallback(async () => {
    if (!activeAccountId) return
    setBusy('handoff-targets')
    try {
      const targets = await window.platformApi.handoffTargets(activeAccountId)
      if (!Array.isArray(targets)) throw new Error(operationError(targets) || '平台未返回可转人工目标')
      setHandoffTargets(targets)
      setSelectedHandoffTarget('')
      notify(targets.length ? `已读取 ${targets.length} 个官方转人工目标` : '当前平台没有可转人工目标')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify])

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
      if (event.accountId !== activeAccountId) return
      if (event.type === 'connection') {
        const nextStatus = event.payload as PlatformStatus
        setStatus(nextStatus)
        if (!nextStatus.authenticated) {
          setMessageListening(false)
          setOrderListening(false)
          setOrderWatermark(undefined)
          setHandoffTargets([])
          setSelectedHandoffTarget('')
        }
      }
      if (event.type === 'message') {
        const message = extractMessage(event.payload)
        if (!message) return
        setMessages((current) => upsertPlatformMessage(current, message))
        setSessions((current) => current.some((item) => item.id === message.sessionId) ? current : [{ id: message.sessionId, title: message.senderName || '新会话', unread: 0 }, ...current])
      }
    })
    void refresh()
    return dispose
  }, [activeAccountId, refresh])

  return <div className="app-shell">
    <header className="app-topbar"><div className="topbar-title"><span className="topbar-mark"><Activity size={18} /></span><div><strong>平台工作台</strong><small>统一管理店铺、消息、商品与订单</small></div></div><div className="topbar-actions"><span className="topbar-live"><span className="live-dot" />{activeAccount ? `${activePlatform?.label || activeAccount.platform} · ${activeAccount.label}` : '未选择店铺'}</span><button className="topbar-button" onClick={() => void refresh()}><RefreshCw size={15} />刷新</button><button className="topbar-icon" title="通知"><Bell size={17} /></button><button className="topbar-icon" title="设置"><Settings2 size={17} /></button></div></header>
    <main className="app-layout"><StoreSidebar platforms={platforms} accounts={accounts} activeAccountId={activeAccountId} selectedPlatform={selectedPlatform} label={label} busy={busy} onPlatformChange={setSelectedPlatform} onLabelChange={setLabel} onAdd={() => void addAccount()} onSelect={(account) => void openAccount(account)} onRemove={(account) => void removeAccount(account)} onImport={() => void importHook()} /><PlatformViewport account={activeAccount} platform={activePlatform} status={status} sessions={sessions} messages={messages} products={products} events={events.filter((item) => item.accountId === activeAccountId)} busy={busy} selectedSessionId={selectedSessionId} messageDraft={messageDraft} messageListening={messageListening} orderListening={orderListening} orderWatermark={orderWatermark} handoffTargets={handoffTargets} selectedHandoffTarget={selectedHandoffTarget} onRefreshSessions={() => void refreshSessions()} onCollectProducts={() => void collectProducts()} onSelectSession={selectSession} onMessageDraftChange={setMessageDraft} onStartMessages={() => void startMessageListening()} onSendMessage={() => void sendTestMessage()} onStartOrders={() => void startOrderListening()} onLoadHandoffTargets={() => void loadHandoffTargets()} onSelectHandoffTarget={setSelectedHandoffTarget} onTransfer={() => void transferSession()} eventSummary={eventSummary} /></main>
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
