export interface HookAuthState {
    authenticated: boolean;
    shopId?: string;
    userId?: string;
    checkedAt?: number;
}
export interface HookSessionSummary {
    id: string;
    title: string;
    unreadCount: number;
    lastMessage?: string;
    updatedAt?: number;
    avatarUrl?: string;
}
export type HookMessageType = 'text' | 'image' | 'file' | 'system' | 'order' | 'product' | 'unknown';
export interface HookMessage {
    id: string;
    sessionId: string;
    senderId: string;
    senderName?: string;
    content: string;
    type: HookMessageType;
    direction: 'inbound' | 'outbound';
    isMine: boolean;
    timestamp: number;
    attachments?: Array<{
        url?: string;
        name?: string;
        mimeType?: string;
    }>;
    raw?: unknown;
}
export interface HookProductSku {
    id: string;
    name?: string;
    price: number;
    stockQuantity?: number;
}
export type HookProductStatus = 'on_sale' | 'off_sale' | 'draft' | 'unknown';
export interface HookProduct {
    id: string;
    name: string;
    price: number;
    status: HookProductStatus;
    stockQuantity?: number;
    images: string[];
    skus?: HookProductSku[];
    shopId?: string;
    updatedAt?: number;
    raw?: unknown;
}
export type HookOrderStatus = 'created' | 'paid' | 'processing' | 'shipped' | 'completed' | 'cancelled' | 'refunding' | 'refunded' | 'unknown';
export interface HookOrder {
    id: string;
    status: HookOrderStatus;
    totalAmount: number;
    quantity?: number;
    productId?: string;
    productName?: string;
    buyerId?: string;
    receiverName?: string;
    shopId?: string;
    createdAt?: number;
    updatedAt?: number;
    raw?: unknown;
}
//# sourceMappingURL=index.d.ts.map