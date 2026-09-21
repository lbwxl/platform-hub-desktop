import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Bell, RefreshCw, Settings2 } from 'lucide-react'
import type { ChatSession, PlatformAccount, PlatformDefinition, PlatformEvent, PlatformMessage, PlatformStatus, ProductRecord } from '../../shared/platform'
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
  const [messages, setMessages] = useState<PlatformMessage[]>([])
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
    try { setMessages(await window.platformApi.messages(accountId, sessionId)) } catch (error) { notify(errorMessage(error)) }
  }, [notify])

  const refreshSessions = useCallback(async (accountId = activeAccountId) => {
    if (!accountId) return
    setBusy('sessions')
    try {
      const nextSessions = await window.platformApi.sessions(accountId)
      setSessions(nextSessions)
      if (nextSessions[0]) await loadMessages(accountId, nextSessions[0].id)
      notify(`已读取 ${nextSessions.length} 个会话`)
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, loadMessages, notify])

  const refresh = useCallback(async () => {
    try {
      const [nextPlatforms, nextAccounts] = await Promise.all([window.platformApi.platforms.list(), window.platformApi.accounts.list()])
      setPlatforms(nextPlatforms); setAccounts(nextAccounts)
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
      notify('店铺已打开，请在 Electron 平台窗口中完成登录')
    } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activePlatform, inspect, label, notify, selectedPlatform])

  const openAccount = useCallback(async (account: PlatformAccount) => {
    setActiveAccountId(account.id); setBusy(`open:${account.id}`)
    try { await window.platformApi.accounts.open(account.id); await inspect(account.id); notify('平台窗口已打开，Hook 正在等待登录') } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
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
    try { setProducts(await window.platformApi.collectProducts(activeAccountId)); notify('商品采集完成') } catch (error) { notify(errorMessage(error)) } finally { setBusy('') }
  }, [activeAccountId, notify])

  const eventSummary = useCallback((event: PlatformEvent) => {
    if (!event.payload || typeof event.payload !== 'object') return String(event.payload || event.type)
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'order') return `订单事件 · ${String((payload.order as Record<string, unknown> | undefined)?.status || '状态变化')}`
    if (event.type === 'message') return `收到消息 · ${String((payload as { content?: string }).content || '新消息')}`
    return `${event.type} · ${String(payload.message || payload.connected || payload.authenticated || '')}`
  }, [])

  useEffect(() => {
    const dispose = window.platformApi.onEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 80))
      if (event.accountId !== activeAccountId) return
      if (event.type === 'connection') setStatus(event.payload as PlatformStatus)
      if (event.type === 'message') {
        const message = event.payload as PlatformMessage
        setMessages((current) => upsertPlatformMessage(current, message))
        setSessions((current) => current.some((item) => item.id === message.sessionId) ? current : [{ id: message.sessionId, title: message.senderName || '新会话', unread: 0 }, ...current])
      }
    })
    void refresh()
    return dispose
  }, [activeAccountId, refresh])

  return <div className="app-shell">
    <header className="app-topbar"><div className="topbar-title"><span className="topbar-mark"><Activity size={18} /></span><div><strong>平台工作台</strong><small>统一管理店铺、消息、商品与订单</small></div></div><div className="topbar-actions"><span className="topbar-live"><span className="live-dot" />{activeAccount ? `${activePlatform?.label || activeAccount.platform} · ${activeAccount.label}` : '未选择店铺'}</span><button className="topbar-button" onClick={() => void refresh()}><RefreshCw size={15} />刷新</button><button className="topbar-icon" title="通知"><Bell size={17} /></button><button className="topbar-icon" title="设置"><Settings2 size={17} /></button></div></header>
    <main className="app-layout"><StoreSidebar platforms={platforms} accounts={accounts} activeAccountId={activeAccountId} selectedPlatform={selectedPlatform} label={label} busy={busy} onPlatformChange={setSelectedPlatform} onLabelChange={setLabel} onAdd={() => void addAccount()} onSelect={(account) => void openAccount(account)} onRemove={(account) => void removeAccount(account)} onImport={() => void importHook()} /><PlatformViewport account={activeAccount} platform={activePlatform} status={status} sessions={sessions} messages={messages} products={products} events={events.filter((item) => item.accountId === activeAccountId)} busy={busy} onRefreshSessions={() => void refreshSessions()} onCollectProducts={() => void collectProducts()} eventSummary={eventSummary} /></main>
    {toast && <div className="toast"><Activity size={15} />{toast}</div>}
  </div>
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
