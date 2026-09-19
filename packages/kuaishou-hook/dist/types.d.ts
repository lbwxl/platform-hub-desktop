export type PlatformCapability = 'messages.listen' | 'messages.history' | 'messages.send' | 'messages.file' | 'sessions.list' | 'products.collect' | 'products.detail' | 'orders.read' | 'orders.listen' | 'session.transfer';
export interface HookRuntimePage {
    id: string;
    url: string;
    methods: string[];
    refreshBeforeInvoke?: boolean;
}
export interface HookPackageManifest {
    id: string;
    label: string;
    version: string;
    url: string;
    match?: string[];
    capabilities: PlatformCapability[];
    script: string;
    entry?: string;
    runtimePages?: HookRuntimePage[];
    source?: 'builtin' | 'imported';
}
export interface AuthState {
    authenticated: boolean;
    shopId?: string;
    userId?: string;
    errorCode?: string;
    [key: string]: unknown;
}
export interface ProductRecord {
    id: string;
    goodsId: string;
    name: string;
    price: number;
    originalPrice?: number;
    stockQuantity?: number;
    status?: string;
    images: string[];
    goodsUrl?: string;
    editUrl?: string;
    shopId?: string;
    platform: string;
    createTime?: string;
    description?: string;
    skuList?: Array<{
        skuId: string;
        skuName: string;
        skuPrice: number;
    }>;
    raw?: Record<string, unknown>;
}
export interface OrderRecord {
    id: string;
    orderId: string;
    skuOrderId?: string;
    skuId?: string;
    skuName?: string;
    status?: string;
    totalAmount?: number;
    quantity?: number;
    productId?: string;
    productName?: string;
    productImage?: string;
    orderUrl?: string;
    buyerName?: string;
    receiverName?: string;
    shippingAddress?: string;
    shopId?: string;
    sessionId?: string;
    userId?: string;
    messageId?: string;
    updatedAt?: number;
    platform: string;
    raw?: Record<string, unknown>;
}
export interface OrderEventPayload {
    order: OrderRecord;
    sessionId: string;
    userId?: string;
    messageId: string;
    source: 'message' | 'platform-runtime' | 'session-history' | 'workstation' | 'combined';
    timestamp: number;
}
export interface OrderSyncResult {
    orders: OrderRecord[];
    authoritative: boolean;
    source: 'session-history' | 'platform-runtime' | 'combined' | 'none';
    syncedAt: number;
    sessionId?: string;
    userId?: string;
    errorCode?: string;
    error?: string;
}
export interface ChatSession {
    id: string;
    title: string;
    unread: number;
    lastMessage?: string;
    avatar?: string;
    updatedAt?: number;
}
export interface PlatformMessage {
    id: string;
    sessionId: string;
    senderId: string;
    senderName: string;
    content: string;
    type: string;
    isMine: boolean;
    timestamp: number;
    avatar?: string;
    order?: OrderRecord;
    product?: ProductRecord;
    raw?: Record<string, unknown>;
}
export interface HookEvent {
    type: 'ready' | 'message' | 'order' | 'error' | string;
    payload: unknown;
    timestamp?: number;
}
export interface OperationResult<T = unknown> {
    success?: boolean;
    ok?: boolean;
    value?: T;
    errorCode?: string;
    error?: string;
    [key: string]: unknown;
}
//# sourceMappingURL=types.d.ts.map