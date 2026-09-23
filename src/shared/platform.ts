export type PlatformId = 'douyin-shop' | 'kuaishou-shop' | 'goofish' | string

export type PlatformExecutionModel = 'page' | 'native' | 'service'

export type PlatformCapability =
  | 'messages.listen'
  | 'messages.history'
  | 'messages.send'
  | 'messages.file'
  | 'sessions.list'
  | 'products.collect'
  | 'products.detail'
  | 'orders.read'
  | 'orders.listen'
  | 'session.transfer'

export interface PlatformAccount {
  id: string
  platform: PlatformId
  label: string
  url: string
  partition: string
  webContentsId?: number
  connected: boolean
  authenticated: boolean
  /** AI automation lifecycle. This is independent from the selected UI account. */
  online: boolean
  runtimeState: 'stopped' | 'starting' | 'running' | 'error'
  messageListening?: boolean
  lastSeenAt?: string
  createdAt: string
}

export interface PlatformDefinition {
  id: PlatformId
  label: string
  url: string
  executionModel?: PlatformExecutionModel
  capabilities: PlatformCapability[]
  hookVersion?: string
  source: 'builtin' | 'imported'
}

export interface ProductRecord {
  id: string
  goodsId: string
  name: string
  price: number
  originalPrice?: number
  stockQuantity?: number
  status?: string
  images: string[]
  goodsUrl?: string
  editUrl?: string
  shopId?: string
  platform: PlatformId
  createTime?: string
  /** Authoritative timestamp returned by the platform product list response. */
  updatedAt?: number
  description?: string
  skuList?: Array<{ skuId: string; skuName: string; skuPrice: number }>
  raw?: Record<string, unknown>
}

export interface OrderRecord {
  id: string
  orderId: string
  skuOrderId?: string
  skuId?: string
  skuName?: string
  status?: string
  totalAmount?: number
  quantity?: number
  productId?: string
  productName?: string
  productImage?: string
  orderUrl?: string
  buyerName?: string
  receiverName?: string
  shippingAddress?: string
  shopId?: string
  sessionId?: string
  userId?: string
  messageId?: string
  updatedAt?: number
  platform: PlatformId
  raw?: Record<string, unknown>
}

export interface OrderEventPayload {
  order: OrderRecord
  sessionId: string
  userId?: string
  messageId?: string
  source: 'message' | 'platform-runtime' | 'session-history' | 'workstation' | 'combined'
  timestamp: number
}

export interface OrderSyncResult {
  orders: OrderRecord[]
  authoritative: boolean
  source: 'session-history' | 'platform-runtime' | 'workstation' | 'combined' | 'none'
  syncedAt: number
  sessionId?: string
  userId?: string
  errorCode?: string
  error?: string
}

export interface OrderListenResult {
  listening: boolean
  watermark?: number
}

export interface HandoffTarget {
  id?: string
  name: string
}

export interface PlatformMessage {
  id: string
  sessionId: string
  senderId: string
  senderName: string
  content: string
  type: 'text' | 'image' | 'product' | 'order' | 'system' | string
  isMine: boolean
  /** Kept alongside isMine so the Main-process reply pipeline never guesses. */
  direction?: 'inbound' | 'outbound'
  origin?: 'customer' | 'human' | 'automation' | 'system' | 'unknown'
  timestamp: number
  avatar?: string
  order?: OrderRecord
  product?: ProductRecord
  raw?: Record<string, unknown>
}

export interface ChatSession {
  id: string
  title: string
  unread: number
  lastMessage?: string
  avatar?: string
  updatedAt?: number
}

export interface PlatformEvent {
  id: string
  accountId: string
  platform: PlatformId
  type: 'connection' | 'login' | 'message' | 'order' | 'sessions' | 'products' | 'error' | 'log'
  timestamp: number
  payload: unknown
}

export interface PlatformStatus {
  accountId: string
  platform: PlatformId
  connected: boolean
  authenticated: boolean
  url: string
  title?: string
  message: string
}

export interface PlatformRuntimeSnapshot {
  accountId: string
  online: boolean
  runtimeState: PlatformAccount['runtimeState']
  messageListening: boolean
  lastIncomingAt?: number
  lastReplyAt?: number
  lastReplyType?: 'reply' | 'human_required' | 'ignore'
  attention: Record<string, 'pending' | 'opened' | 'resolved'>
}

export interface HookPackageManifest {
  id: PlatformId
  label: string
  version: string
  url: string
  executionModel?: PlatformExecutionModel
  loginUrl?: string
  loginMatch?: string[]
  match?: string[]
  capabilities: PlatformCapability[]
  script?: string
  entry?: string
  runtimePages?: Array<{
    id: string
    url: string
    methods: string[]
    refreshBeforeInvoke?: boolean
    persistent?: boolean
  }>
  source?: 'builtin' | 'imported'
}

export interface ImportedHookPackage {
  manifest: HookPackageManifest
  filePath?: string
}

export interface PlatformApi {
  accounts: {
    list(): Promise<PlatformAccount[]>
    add(input: { platform: PlatformId; label: string; url?: string }): Promise<PlatformAccount>
    remove(accountId: string): Promise<void>
    open(accountId: string): Promise<PlatformAccount>
    setOnline(accountId: string, online: boolean): Promise<PlatformAccount>
  }
  platforms: {
    list(): Promise<PlatformDefinition[]>
    importPackage(): Promise<PlatformDefinition | null>
  }
  connect(accountId: string, webContentsId: number): Promise<PlatformStatus>
  disconnect(accountId: string): Promise<void>
  status(accountId: string): Promise<PlatformStatus>
  collectProducts(accountId: string): Promise<ProductRecord[]>
  productDetail(accountId: string, goodsId: string): Promise<ProductRecord>
  sessions(accountId: string): Promise<ChatSession[]>
  messages(accountId: string, sessionId: string): Promise<PlatformMessage[]>
  orders(accountId: string, userId?: string): Promise<unknown[]>
  syncOrders(accountId: string, sessionId?: string, userId?: string): Promise<OrderSyncResult>
  listenOrders(accountId: string, sessionId?: string, orderId?: string): Promise<OrderListenResult>
  listenMessages(accountId: string): Promise<{ listening: boolean; watermark?: number }>
  handoffTargets(accountId: string): Promise<HandoffTarget[]>
  sendMessage(accountId: string, sessionId: string, content: string): Promise<{ success: boolean; error?: string }>
  sendFile(accountId: string, sessionId: string, dataUrl: string, fileName?: string): Promise<{ success: boolean; error?: string }>
  transferSession(accountId: string, sessionId: string, target: string): Promise<unknown>
  setConversationAttention(accountId: string, conversationId: string, state: 'pending' | 'opened' | 'resolved'): Promise<void>
  setPrimaryViewportBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  runtimeStates(): Promise<PlatformRuntimeSnapshot[]>
  onEvent(callback: (event: PlatformEvent) => void): () => void
}
