export interface HookAuthState {
  authenticated: boolean
  shopId?: string
  userId?: string
  checkedAt?: number
}

export interface HookSessionSummary {
  id: string
  title: string
  unreadCount: number
  lastMessage?: string
  updatedAt?: number
  avatarUrl?: string
}

export type HookMessageType = 'text' | 'image' | 'file' | 'system' | 'order' | 'product' | 'unknown'

export type HookMessageOrigin = 'customer' | 'human' | 'automation' | 'system' | 'unknown'
export type HookMessageDeliveryStatus = 'pending' | 'sent' | 'failed'

export interface HookMessage {
  id: string
  conversationId: string
  senderId?: string
  senderName?: string
  content: string
  type: HookMessageType
  direction: 'inbound' | 'outbound'
  origin: HookMessageOrigin
  deliveryStatus?: HookMessageDeliveryStatus
  timestamp: number
  attachments?: Array<{ url?: string; name?: string; mimeType?: string }>
  raw?: unknown
}

export interface HookMoney {
  amount: number
  currency: string
}

export interface HookProductSku {
  id: string
  externalId?: string
  name: string
  price?: HookMoney
  stockQuantity?: number
}

export type HookProductStatus = 'on_sale' | 'off_sale' | 'draft' | 'unknown'

export interface HookProduct {
  id: string
  externalId: string
  title: string
  description?: string
  status: HookProductStatus
  price?: HookMoney
  stockQuantity?: number
  images: string[]
  skus: HookProductSku[]
  url?: string
  updatedAt?: number
  raw?: unknown
}

export type HookOrderStatus =
  | 'created'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'completed'
  | 'cancelled'
  | 'refunding'
  | 'refunded'
  | 'unknown'

export interface HookOrderItem {
  productId?: string
  externalProductId?: string
  skuId?: string
  skuName?: string
  title: string
  quantity: number
  price?: HookMoney
}

export interface HookOrder {
  id: string
  externalId: string
  shopId?: string
  conversationId?: string
  buyer?: {
    id?: string
    name?: string
  }
  status: HookOrderStatus
  items: HookOrderItem[]
  total?: HookMoney
  receiver?: {
    name?: string
    phoneMasked?: string
    address?: string
  }
  createdAt?: number
  updatedAt?: number
  raw?: unknown
}

export interface HookHandoffTarget {
  id?: string
  name: string
}

export interface HookHandoffTransferInput {
  conversationId: string
  targetId?: string
  targetName?: string
  remark?: string
}

export interface HookHandoffTransferResult {
  transferred: boolean
  target?: HookHandoffTarget
}
