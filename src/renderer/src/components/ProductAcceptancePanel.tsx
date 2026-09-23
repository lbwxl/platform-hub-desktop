import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Clock3, ExternalLink, Search, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { ProductRecord } from '../../../shared/platform'
import { filterProducts, productStats, type ProductAcceptanceState, type ProductChangedField } from '../productAcceptance'

export interface ProductAcceptancePanelProps {
  state: ProductAcceptanceState
  authenticated: boolean
  supportsProducts: boolean
  supportsProductCollect: boolean
  busy: string
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onCollectProducts: () => void
}

export function ProductAcceptancePanel(props: ProductAcceptancePanelProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const stats = productStats(props.state.currentProducts)
  const filteredProducts = useMemo(
    () => filterProducts(props.state.currentProducts, props.searchQuery),
    [props.searchQuery, props.state.currentProducts],
  )
  const syncing = props.state.syncState === 'syncing' || props.busy === 'products'
  const statusLabel = props.state.syncState === 'syncing'
    ? 'syncing'
    : props.state.syncState
  const completeness = props.state.syncState === 'success' && stats.duplicateCount === 0 && stats.allOnSale

  return <div className="product-acceptance-panel">
    <p className="acceptance-help">通过正式 products.list 获取当前店铺全部在售商品；失败时保留上一次成功结果，避免把失败误判为“商品为 0”。</p>
    {!props.supportsProducts ? <div className="acceptance-unavailable"><AlertCircle size={14} />当前平台未声明商品能力。</div> : <>
      <div className="product-sync-toolbar">
        <button className="action-button purple" onClick={props.onCollectProducts} disabled={!props.authenticated || syncing || !props.supportsProductCollect}>
          <Clock3 size={14} />{syncing ? '全量同步中…' : '开始全量同步'}
        </button>
        <span className={`product-sync-state ${statusLabel}`}><span />{statusLabel}</span>
        <button className="mini-button product-detail-toggle" onClick={() => setDetailsOpen((value) => !value)} disabled={!props.state.currentProducts.length && props.state.syncState === 'idle'}>
          {detailsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{detailsOpen ? '收起详情' : '查看详情'}
        </button>
      </div>
      <div className="product-sync-summary">
        <ProductMetric label="官方在售商品" value={String(stats.count)} />
        <ProductMetric label="唯一 externalId" value={String(stats.uniqueCount)} />
        <ProductMetric label="重复" value={String(stats.duplicateCount)} tone={stats.duplicateCount ? 'fail' : 'pass'} />
        <ProductMetric label="完整性" value={completeness ? 'PASS' : 'FAIL'} tone={completeness ? 'pass' : 'fail'} />
      </div>
      {stats.duplicateCount > 0 && <div className="product-duplicate-error"><AlertCircle size={13} />FAIL · 商品 ID 存在重复（{stats.duplicateCount} 条）</div>}
      <div className="product-sync-meta">
        <span>最近同步：{props.state.lastSyncAt ? formatDate(props.state.lastSyncAt) : '—'}</span>
        <span>耗时：{props.state.durationMs === undefined ? '—' : `${props.state.durationMs}ms`}</span>
      </div>
      {props.state.syncState === 'failed' && props.state.error && <div className="product-sync-error">
        <AlertCircle size={14} /><span><strong>FAILED{props.state.error.code ? ` · ${props.state.error.code}` : ''}</strong><small>{props.state.error.code === 'CHALLENGE_REQUIRED' ? '需要完成平台安全验证。' : props.state.error.message}</small></span>
      </div>}
      {props.state.syncState === 'success' && <div className="product-sync-success"><CheckCircle2 size={14} />本次同步成功，当前结果已替换为官方响应。</div>}
      {detailsOpen && <div className="product-acceptance-details">
        <div className="product-acceptance-search"><Search size={14} /><input value={props.searchQuery} onChange={(event) => props.onSearchQueryChange(event.target.value)} placeholder="搜索商品 ID / externalId / 标题" /><span>{props.searchQuery.trim() ? `找到 ${filteredProducts.length} 条` : `${filteredProducts.length} 条`}</span>{props.searchQuery && <button title="清除搜索" onClick={() => props.onSearchQueryChange('')}><X size={13} /></button>}</div>
        <div className="product-human-check"><strong>真人验收：</strong><span>①先同步基线　②官方后台下架商品再同步看“移除”　③重新上架看“新增”　④修改标题/价格看“变化”</span></div>
        <ProductDiffSummary state={props.state} />
        <div className="product-list-heading"><strong>当前在售商品</strong><span>{props.searchQuery.trim() && filteredProducts.length === 0 ? '当前在售商品中未找到' : `显示 ${filteredProducts.length} / ${stats.count}`}</span></div>
        <div className="product-acceptance-list">{filteredProducts.map((product) => <ProductRow key={`${productKeyForRow(product)}:${product.id}`} product={product} />)}{!filteredProducts.length && <span className="muted-line">尚未同步商品，或搜索条件没有匹配项。</span>}</div>
      </div>}
    </>}
  </div>
}

function ProductDiffSummary({ state }: { state: ProductAcceptanceState }) {
  const diff = state.diff
  return <div className="product-diff-section">
    <div className="product-diff-counts"><span className="added">新增 {diff.added.length}</span><span className="removed">移除 {diff.removed.length}</span><span className="changed">变化 {diff.changed.length}</span><span>未变化 {diff.unchangedCount}</span></div>
    {(diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) && <div className="product-diff-list">
      {diff.added.length > 0 && <DiffGroup title="新增" tone="added">{diff.added.map((product) => <div key={`added-${product.id}`} className="product-diff-item"><b>+</b><span>{product.name}</span><code>{product.goodsId}</code></div>)}</DiffGroup>}
      {diff.removed.length > 0 && <DiffGroup title="移除" tone="removed">{diff.removed.map((product) => <div key={`removed-${product.id}`} className="product-diff-item"><b>−</b><span>{product.name}</span><code>{product.goodsId}</code></div>)}</DiffGroup>}
      {diff.changed.length > 0 && <DiffGroup title="变化" tone="changed">{diff.changed.map((change) => <div key={`changed-${change.after.id}`} className="product-diff-item product-diff-change"><b>~</b><span><strong>{change.after.name}</strong>{change.changedFields.map((field) => <small key={field}>{fieldLabel(field)}：{formatField(change.before, field)} → {formatField(change.after, field)}</small>)}</span><code>{change.after.goodsId}</code></div>)}</DiffGroup>}
    </div>}
  </div>
}

function DiffGroup({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return <details className={`product-diff-group ${tone}`} open><summary>{title}</summary><div>{children}</div></details>
}

function ProductRow({ product }: { product: ProductRecord }) {
  return <div className="product-acceptance-row">
    <div className="product-acceptance-thumb">{product.images?.[0] ? <img src={product.images[0]} alt="" /> : <span>—</span>}</div>
    <div className="product-acceptance-main"><strong>{product.name}</strong><code>{product.goodsId}</code></div>
    <span className="product-cell price">¥{Number(product.price || 0).toFixed(2)}</span>
    <span className="product-cell">库存 {product.stockQuantity ?? '—'}</span>
    <span className={`product-status ${product.status || 'unknown'}`}>{product.status || 'unknown'}</span>
    <span className="product-updated">{product.updatedAt ? formatDate(product.updatedAt) : '—'}</span>
    {product.goodsUrl && <a className="product-external-link" href={product.goodsUrl} target="_blank" rel="noreferrer" title="打开商品"><ExternalLink size={12} /></a>}
  </div>
}

function ProductMetric({ label, value, tone }: { label: string; value: string; tone?: 'pass' | 'fail' }) {
  return <div className="product-metric"><small>{label}</small><strong className={tone || ''}>{value}</strong></div>
}

function productKeyForRow(product: ProductRecord): string { return product.goodsId || product.id }
function formatDate(value: number): string { return new Date(value).toLocaleString() }
function fieldLabel(field: ProductChangedField): string { return ({ name: '标题', price: '价格', stockQuantity: '库存', status: '状态', updatedAt: '更新时间' })[field] }
function formatField(product: ProductRecord, field: ProductChangedField): string {
  const value = product[field]
  if (value === undefined || value === null || value === '') return '—'
  if (field === 'price') return `¥${Number(value).toFixed(2)}`
  if (field === 'updatedAt') return formatDate(Number(value))
  return String(value)
}
