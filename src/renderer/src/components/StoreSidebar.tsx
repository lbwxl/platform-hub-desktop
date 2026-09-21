import { Plus, Store, Trash2, Upload, Wifi } from 'lucide-react'
import type { PlatformAccount, PlatformDefinition } from '../../../shared/platform'

export interface StoreSidebarProps {
  platforms: PlatformDefinition[]
  accounts: PlatformAccount[]
  activeAccountId: string
  selectedPlatform: string
  label: string
  busy: string
  onPlatformChange: (platform: string) => void
  onLabelChange: (label: string) => void
  onAdd: () => void
  onSelect: (account: PlatformAccount) => void
  onRemove: (account: PlatformAccount) => void
  onImport: () => void
}

export function StoreSidebar(props: StoreSidebarProps) {
  return (
    <aside className="store-sidebar">
      <div className="sidebar-brand"><span className="sidebar-brand-mark"><Store size={20} /></span><div><strong>多平台聚合助手</strong><small>Platform Hook workspace</small></div></div>
      <div className="sidebar-heading"><span>店铺列表</span><button className="round-action" title="添加店铺" onClick={props.onAdd}><Plus size={17} /></button></div>
      <div className="store-create">
        <select value={props.selectedPlatform} onChange={(event) => props.onPlatformChange(event.target.value)} aria-label="选择平台">
          {props.platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.label}</option>)}
        </select>
        <input value={props.label} onChange={(event) => props.onLabelChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') props.onAdd() }} placeholder="店铺名称（可选）" />
        <button className="add-store-button" disabled={props.busy === 'add'} onClick={props.onAdd}><Plus size={16} />添加并打开店铺</button>
      </div>
      <div className="store-list">
        {props.accounts.map((account) => {
          const platform = props.platforms.find((item) => item.id === account.platform)
          const ready = account.connected && account.authenticated
          return <button key={account.id} className={`store-item ${account.id === props.activeAccountId ? 'selected' : ''}`} onClick={() => props.onSelect(account)}>
            <span className="store-avatar">{(platform?.label || account.platform).slice(0, 1)}</span>
            <span className="store-meta"><strong>{account.label}</strong><small>{platform?.label || account.platform} · {ready ? '已连接' : account.connected ? '等待登录' : '未连接'}</small></span>
            <span className={`connection-dot ${ready ? 'ready' : ''}`} />
            <span className="store-remove" role="button" title="移除店铺" onClick={(event) => { event.stopPropagation(); props.onRemove(account) }}><Trash2 size={14} /></span>
          </button>
        })}
        {!props.accounts.length && <div className="store-empty"><Store size={28} /><strong>还没有店铺</strong><span>添加店铺后，登录会话会独立保存</span></div>}
      </div>
      <button className="import-button" onClick={props.onImport}><Upload size={15} />导入 Hook 包</button>
      <div className="sidebar-footer"><Wifi size={14} /><span>Hook runtime · Electron CDP</span></div>
    </aside>
  )
}
