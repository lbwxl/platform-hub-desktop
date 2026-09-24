import { hookError, } from '@platform-hub/hook-sdk';
export function asRecord(value) {
    return value && typeof value === 'object' ? value : {};
}
export function normalizeDouyinAuth(value, checkedAt = Date.now()) {
    const item = asRecord(value);
    const shopId = identifier(item.shopId ?? item.shop_id ?? asRecord(item.shopInfo).id);
    const userId = identifier(item.userId ?? item.user_id ?? item.id ?? asRecord(item.selfInfo).id);
    return {
        authenticated: item.authenticated === true || item.isLogin === true || item.loggedIn === true || Boolean(shopId || userId),
        ...(shopId ? { shopId } : {}),
        ...(userId ? { userId } : {}),
        checkedAt,
    };
}
export function normalizeDouyinSession(value) {
    const item = asRecord(value);
    const id = text(item.sessionId ?? item.conversationId ?? item.id ?? item.userId ?? item.uid);
    if (!id)
        return undefined;
    const last = asRecord(item.lastMessage ?? item.last_message);
    const updatedAt = timestamp(item.updatedAt ?? item.updateTime ?? item.timestamp ?? item.versionTime ?? last.createTime ?? last.timestamp);
    return {
        id,
        title: text(item.title ?? item.userName ?? item.username ?? item.name ?? item.buyerName) || '用户',
        unreadCount: finiteNumber(item.unreadCount ?? item.unread_count ?? item.unread) ?? 0,
        ...(text(last.content ?? last.text ?? last.message ?? item.lastMessageText) ? { lastMessage: text(last.content ?? last.text ?? last.message ?? item.lastMessageText) } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(text(item.avatarUrl ?? item.avatar ?? item.userAvatar) ? { avatarUrl: text(item.avatarUrl ?? item.avatar ?? item.userAvatar) } : {}),
    };
}
export function normalizeDouyinMessage(value, context = {}) {
    const item = asRecord(asRecord(value).message ?? asRecord(value).data ?? asRecord(value).payload ?? value);
    const ext = parseRecord(item.ext);
    const conversationId = text(item.conversationId ?? item.originConversationId ?? item.securityConversationId ?? item.sessionId ?? context.conversationId);
    const id = text(item.serverId ?? item.messageId ?? item.clientId ?? item.id);
    if (!conversationId || !id)
        return undefined;
    const senderId = text(item.sender ?? item.senderId ?? item.originSender ?? item.securitySender ?? item.from);
    const senderRole = text(ext.sender_role ?? ext['s:sender_biz_role'] ?? item.senderRole);
    const system = senderRole === '3' || senderRole === '4' || explicitSystemEvidence(item, ext)
        || (senderRole !== '1' && isOfficialServiceNotice(text(item.content ?? item.text ?? item.message)));
    const direction = !system && (item.isMine === true || senderId === context.selfId || senderRole === '2') ? 'outbound' : 'inbound';
    const content = text(item.content ?? item.text ?? item.message);
    const type = messageType(item, ext, system);
    const origin = messageOrigin(item, ext, direction, system);
    const attachment = attachmentFrom(item, ext);
    const messageTimestamp = timestamp(item.createTime ?? item.createdAt ?? item.timestamp ?? item.timestampMs) ?? Date.now();
    return {
        id,
        conversationId,
        ...(senderId ? { senderId } : {}),
        ...(text(ext.uname ?? item.senderName ?? context.conversationTitle) ? { senderName: system ? '系统' : text(ext.uname ?? item.senderName ?? context.conversationTitle) } : {}),
        content,
        type,
        direction,
        origin,
        deliveryStatus: deliveryStatus(item, direction),
        timestamp: messageTimestamp,
        ...(attachment ? { attachments: [attachment] } : {}),
        raw: {
            senderRole,
            source: explicitSource(item, ext) || undefined,
            platformType: text(ext.type ?? item.messageType ?? item.type) || undefined,
            provisional: !item.serverId && !item.messageId && Boolean(item.clientId),
            attributionMetadata: attributionMetadata(item, ext),
        },
    };
}
export function normalizeDouyinProduct(value, fallbackShopId = '') {
    const item = asRecord(value);
    const externalId = text(item.goodsId ?? item.goods_id ?? item.productId ?? item.product_id ?? item.id);
    if (!externalId)
        return undefined;
    const shopId = text(item.shopId ?? item.shop_id ?? item.sellerId) || fallbackShopId;
    const rawPrice = item.discount_price ?? item.discountPrice ?? item.price;
    const price = moneyAmount(rawPrice, item.discount_price !== undefined);
    const images = array(item.images ?? item.pics ?? item.image_list ?? (item.img ? [item.img] : []))
        .map((image) => typeof image === 'string' ? image : text(asRecord(image).url))
        .filter(Boolean);
    const skus = pickArray(item.skus ?? item.skuList).map((rawSku) => {
        const sku = asRecord(rawSku);
        const skuId = text(sku.skuId ?? sku.sku_id ?? sku.id);
        const skuPrice = moneyAmount(sku.skuPrice ?? sku.price, sku.skuPrice === undefined && sku.price !== undefined);
        return {
            id: skuId || `${externalId}:default`,
            ...(skuId ? { externalId: skuId } : {}),
            name: text(sku.skuName ?? sku.spec_desc ?? sku.name) || '默认',
            ...(skuPrice !== undefined ? { price: { amount: skuPrice, currency: 'CNY' } } : {}),
            ...(finiteNumber(sku.stockQuantity ?? sku.stock_num ?? sku.stock) !== undefined ? { stockQuantity: finiteNumber(sku.stockQuantity ?? sku.stock_num ?? sku.stock) } : {}),
        };
    });
    const updatedAt = timestamp(item.updatedAt ?? item.update_time ?? item.modify_time);
    return {
        id: `douyin:${shopId || 'unknown'}:${externalId}`,
        externalId,
        title: text(item.name ?? item.title ?? item.product_name) || '未命名商品',
        ...(text(item.description ?? item.desc) ? { description: text(item.description ?? item.desc) } : {}),
        status: normalizeDouyinProductStatus(item),
        ...(price !== undefined ? { price: { amount: price, currency: 'CNY' } } : {}),
        ...(finiteNumber(item.stockQuantity ?? item.stock_num ?? item.stock) !== undefined ? { stockQuantity: finiteNumber(item.stockQuantity ?? item.stock_num ?? item.stock) } : {}),
        images,
        skus,
        ...(text(item.goodsUrl ?? item.product_url ?? item.detail_url) ? { url: text(item.goodsUrl ?? item.product_url ?? item.detail_url) } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        raw: { shopId: shopId || undefined, platformStatus: item.status ?? item.product_status },
    };
}
export function normalizeDouyinProductStatus(value) {
    const raw = asRecord(value);
    const status = text(raw.status ?? raw.product_status ?? value).toLowerCase();
    const statusText = text(raw.tab ?? raw.status_text ?? raw.status_desc ?? raw.put_status_text).toLowerCase();
    const source = `${status} ${statusText}`;
    if (!status && !statusText)
        return 'unknown';
    if (/off[_ -]?sale|off.?line|下架|已下架|停售|审核驳回/.test(source) || ['3', '4'].includes(status))
        return 'off_sale';
    if (/on[_ -]?sale|selling|online|在售|售卖中|上架/.test(source) || ['1', '2'].includes(status) || raw.is_online === 1 || raw.is_online === true)
        return 'on_sale';
    if (/draft|草稿/.test(source))
        return 'draft';
    return 'unknown';
}
export function normalizeDouyinOrder(value, context = {}) {
    const item = asRecord(value);
    const externalId = text(item.orderId ?? item.order_id ?? item.shopOrderId ?? item.shop_order_id ?? item.skuOrderId ?? item.sku_order_id ?? item.id);
    if (!externalId)
        return undefined;
    const shopId = text(item.shopId ?? item.shop_id) || context.shopId;
    const directItems = pickArray(item.items ?? item.orderItems ?? item.skuOrders);
    const quantity = finiteNumber(item.quantity ?? item.count ?? item.product_count ?? item.item_num) ?? 1;
    const fallbackItem = {
        productId: text(item.productId ?? item.product_id ?? item.goodsId ?? item.goods_id) || undefined,
        externalProductId: text(item.productId ?? item.product_id ?? item.goodsId ?? item.goods_id) || undefined,
        skuId: text(item.skuId ?? item.sku_id) || undefined,
        skuName: text(item.skuName ?? item.sku_name ?? item.spec_desc ?? item.goods_spec_desc ?? item.sku) || undefined,
        title: text(item.productName ?? item.product_name ?? item.goodsName ?? item.goods_name) || '未知商品',
        quantity,
    };
    const items = (directItems.length ? directItems : [fallbackItem]).map((rawItem) => {
        const orderItem = asRecord(rawItem);
        const itemPrice = orderMoney(orderItem);
        return {
            ...(text(orderItem.productId ?? orderItem.product_id ?? orderItem.goodsId ?? orderItem.goods_id) ? { productId: text(orderItem.productId ?? orderItem.product_id ?? orderItem.goodsId ?? orderItem.goods_id) } : {}),
            ...(text(orderItem.externalProductId ?? orderItem.product_id ?? orderItem.goods_id) ? { externalProductId: text(orderItem.externalProductId ?? orderItem.product_id ?? orderItem.goods_id) } : {}),
            ...(text(orderItem.skuId ?? orderItem.sku_id) ? { skuId: text(orderItem.skuId ?? orderItem.sku_id) } : {}),
            ...(text(orderItem.skuName ?? orderItem.sku_name ?? orderItem.spec_desc ?? orderItem.goods_spec_desc ?? orderItem.sku) ? { skuName: text(orderItem.skuName ?? orderItem.sku_name ?? orderItem.spec_desc ?? orderItem.goods_spec_desc ?? orderItem.sku) } : {}),
            title: text(orderItem.title ?? orderItem.productName ?? orderItem.product_name ?? orderItem.goodsName ?? orderItem.goods_name) || '未知商品',
            quantity: finiteNumber(orderItem.quantity ?? orderItem.count ?? orderItem.item_num) ?? quantity,
            ...(itemPrice !== undefined ? { price: { amount: itemPrice, currency: 'CNY' } } : {}),
        };
    });
    const total = orderMoney(item);
    const createdAt = timestamp(item.createdAt ?? item.create_time ?? item.order_create_time);
    const updatedAt = timestamp(item.updatedAt ?? item.update_time ?? item.timestamp);
    const receiverName = text(item.receiverName ?? item.receiver_name);
    const phoneMasked = text(item.phoneMasked ?? item.receiver_phone_mask ?? item.mobile_mask);
    const address = text(item.shippingAddress ?? item.shipping_address ?? item.receiverAddress ?? item.receiver_address);
    const rawStatus = item.status_desc ?? item.order_status_desc ?? item.status ?? item.orderStatus ?? item.order_status;
    const afterSaleStatus = item.platformAftersaleStatus ?? item.aftersaleStatus ?? item.aftersale_sum_status_desc ?? item.after_sale_status;
    const afterSaleNormalized = normalizeDouyinOrderStatus(afterSaleStatus);
    let normalizedStatus = afterSaleNormalized !== 'unknown' ? afterSaleNormalized : normalizeDouyinOrderStatus(rawStatus);
    if (normalizedStatus === 'unknown') {
        const code = text(item.order_status ?? item.orderStatus ?? item.status);
        normalizedStatus = { '1': 'created', '2': 'processing', '3': 'shipped', '4': 'cancelled' }[code] || normalizedStatus;
    }
    const status = normalizedStatus === 'unknown' && finiteNumber(item.pay_time) ? 'paid' : normalizedStatus;
    return {
        id: `douyin:${shopId || 'unknown'}:${externalId}`,
        externalId,
        ...(shopId ? { shopId } : {}),
        ...(text(item.conversationId ?? item.sessionId ?? context.conversationId) ? { conversationId: text(item.conversationId ?? item.sessionId ?? context.conversationId) } : {}),
        ...((text(item.buyerId ?? item.userId) || text(item.buyerName ?? item.buyer_name)) ? {
            buyer: {
                ...(text(item.buyerId ?? item.userId) ? { id: text(item.buyerId ?? item.userId) } : {}),
                ...(text(item.buyerName ?? item.buyer_name) ? { name: text(item.buyerName ?? item.buyer_name) } : {}),
            },
        } : {}),
        status,
        items,
        ...(total !== undefined ? { total: { amount: total, currency: 'CNY' } } : {}),
        ...((receiverName || phoneMasked || address) ? { receiver: { ...(receiverName ? { name: receiverName } : {}), ...(phoneMasked ? { phoneMasked } : {}), ...(address ? { address } : {}) } } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        raw: { platformStatus: item.status ?? item.orderStatus ?? item.order_status ?? item.status_desc ?? item.order_status_desc },
    };
}
export function normalizeDouyinOrderStatus(value) {
    const status = text(value).trim().toLowerCase();
    if (!status)
        return 'unknown';
    if (/退款成功|退款完成|已退款|refund(?:ed|_success)/.test(status))
        return 'refunded';
    if (/退款|退货|售后|refund|after.?sale/.test(status))
        return 'refunding';
    if (/取消|关闭|已作废|cancel|closed/.test(status))
        return 'cancelled';
    if (/完成|交易成功|已收货|complete|success/.test(status))
        return 'completed';
    if (/已发货|运输中|物流|shipped|shipping/.test(status))
        return 'shipped';
    if (/待发货|备货|处理中|processing/.test(status))
        return 'processing';
    if (/已付款|已支付|支付成功|paid/.test(status))
        return 'paid';
    if (/待付款|待支付|未付款|新订单|created|pending.?pay/.test(status))
        return 'created';
    return 'unknown';
}
export function douyinOrderChangedFields(previous, next) {
    const fields = ['status', 'items', 'total', 'receiver', 'buyer', 'conversationId'];
    return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field])).map(String);
}
export function mapDouyinError(value, fallbackMessage = '抖店平台操作失败') {
    const item = asRecord(value);
    const rawCode = text(item.code ?? item.errorCode ?? item.statusCode).toUpperCase();
    const message = text(item.message ?? item.error ?? item.statusMsg) || fallbackMessage;
    const combined = `${rawCode} ${message}`;
    if (/CHALLENGE|CAPTCHA|VERIFY|RISK|验证码|滑块|安全验证/.test(combined))
        return hookError('CHALLENGE_REQUIRED', message, undefined, true);
    if (/LOGIN|UNAUTH|未登录|登录/.test(combined))
        return hookError('LOGIN_REQUIRED', message);
    if (/RATE|FREQUENCY|TOO[_ ]MANY|频繁|限流/.test(combined))
        return hookError('RATE_LIMITED', message, undefined, true);
    if (/NOT_SUPPORTED|UNSUPPORTED|不支持/.test(combined))
        return hookError('NOT_SUPPORTED', message);
    if (/INVALID|PARAM|TARGET_NOT_FOUND|参数|必填|未找到/.test(combined))
        return hookError('INVALID_INPUT', message);
    if (/RUNTIME_NOT_READY|NOT_READY|尚未准备|不可用/.test(combined))
        return hookError('RUNTIME_NOT_READY', message, undefined, true);
    return hookError('PLATFORM_ERROR', message, undefined, true);
}
function messageType(item, ext, system) {
    const value = text(ext.type ?? item.messageType ?? item.type).toLowerCase();
    if (/order|订单/.test(value) || /order/i.test(text(parseRecord(ext.card_header).cardSourceScene)))
        return 'order';
    if (system)
        return 'system';
    if (/image|图片/.test(value))
        return 'image';
    if (/file|文件/.test(value))
        return 'file';
    if (/goods|product|商品/.test(value) || /(goods|product)/i.test(text(parseRecord(ext.card_header).cardSourceScene)))
        return 'product';
    if (!value || /text|文字/.test(value))
        return 'text';
    return 'unknown';
}
function messageOrigin(item, ext, direction, system) {
    if (system)
        return 'system';
    if (direction === 'inbound')
        return explicitBuyerEvidence(item, ext) ? 'customer' : 'unknown';
    const source = explicitSource(item, ext);
    return manualSendEvidence(ext) || /(?:^|[._ -])(manual|human|staff|agent)(?:$|[._ -])|人工|客服手动/i.test(source) ? 'human' : 'unknown';
}
function explicitSource(item, ext) {
    return [
        ext.send_source, ext.sender_source, ext.operation_source, ext.source,
        item.sendSource, item.senderSource, item.operationSource, item.source,
    ].map(text).filter(Boolean).join(' ');
}
function explicitSystemEvidence(item, ext) {
    const clientMessageId = text(ext['s:client_message_id'] ?? item.clientMessageId);
    return /system|notice|notification|allocated_service|user_enter_from_transfer|系统|通知|接入|转移/i.test([item.messageType, item.type, ext.type, ext.message_type].map(text).join(' '))
        || Boolean(ext.from_event_center)
        || /(?:CsAssign|transfer_staff|close_non_process)/i.test(clientMessageId);
}
function isOfficialServiceNotice(content) {
    return /(?:人工)?客服.{0,30}(?:为您服务|已?接入|已加入(?:会话)?|进入会话)|(?:为您转接|转接给.{0,20}客服|客服.{0,20}(?:接入|已加入(?:会话)?))/i.test(content);
}
function explicitBuyerEvidence(item, ext) {
    const senderRole = text(ext.sender_role ?? ext['s:sender_biz_role'] ?? item.senderRole);
    return senderRole === '1' || /buyer|customer|买家|消费者/i.test(text(ext['s:sender_biz_role'] ?? item.senderRole));
}
function attributionMetadata(item, ext) {
    const result = {};
    for (const [prefix, source] of [['item', item], ['ext', ext]]) {
        for (const [key, value] of Object.entries(source)) {
            if (!/(source|sender|role|staff|agent|operator|manual|client|device|from|mine|creator)/i.test(key))
                continue;
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
                result[`${prefix}.${key}`] = value;
        }
    }
    result.manualSendCheck = manualSendEvidence(ext);
    return result;
}
function manualSendEvidence(ext) {
    return Boolean(text(ext['p:check_Send'] ?? ext['p:check_send'] ?? ext.p_check_send));
}
function attachmentFrom(item, ext) {
    const url = text(item.url ?? item.uri ?? item.imageUrl ?? item.fileUrl ?? ext.url ?? ext.image_url ?? ext.file_url);
    const name = text(item.fileName ?? item.name ?? ext.file_name);
    const mimeType = text(item.mimeType ?? item.mime ?? ext.mime_type);
    return url || name || mimeType ? { ...(url ? { url } : {}), ...(name ? { name } : {}), ...(mimeType ? { mimeType } : {}) } : undefined;
}
function deliveryStatus(item, direction) {
    if (direction === 'inbound')
        return 'sent';
    const status = text(item.deliveryStatus ?? item.sendStatus ?? item.status).toLowerCase();
    if (/fail|error|失败/.test(status))
        return 'failed';
    if (/pending|sending|提交|发送中/.test(status))
        return 'pending';
    return 'sent';
}
function orderMoney(item) {
    const yuan = item.totalAmount ?? item.total_amount ?? item.orderAmount ?? item.order_amount_yuan ?? item.price;
    if (yuan !== undefined && yuan !== null && yuan !== '')
        return finiteNumber(yuan);
    const cents = item.pay_amount ?? item.order_amount ?? item.total_fee;
    const value = finiteNumber(cents);
    return value === undefined ? undefined : value / 100;
}
function moneyAmount(value, cents) {
    const amount = finiteNumber(value);
    return amount === undefined ? undefined : cents ? amount / 100 : amount;
}
function parseRecord(value) {
    if (value && typeof value === 'object')
        return value;
    if (typeof value !== 'string' || !value)
        return {};
    try {
        return asRecord(JSON.parse(value));
    }
    catch {
        return {};
    }
}
function pickArray(value) {
    if (Array.isArray(value))
        return value;
    const item = asRecord(value);
    for (const candidate of [item.data, item.list, item.items, item.records, asRecord(item.data).list, asRecord(item.data).items, asRecord(item.data).records]) {
        if (Array.isArray(candidate))
            return candidate;
    }
    return [];
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function finiteNumber(value) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(/,/g, '')) : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
}
function timestamp(value) {
    const number = finiteNumber(value);
    if (number !== undefined)
        return number > 0 && number < 100_000_000_000 ? number * 1000 : number;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function text(value) {
    return value === undefined || value === null ? '' : String(value);
}
function identifier(value) {
    const result = text(value).trim();
    return result && !['-1', '0', 'null', 'undefined'].includes(result.toLowerCase()) ? result : '';
}
//# sourceMappingURL=normalize.js.map