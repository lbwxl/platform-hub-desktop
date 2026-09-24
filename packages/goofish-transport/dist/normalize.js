export function normalizeGoofishAuth(value, account, checkedAt = Date.now()) {
    const snapshot = asRow(value);
    const metadata = asRow(account);
    const userId = text(snapshot.userId ?? snapshot.user_id ?? metadata.userId);
    const shopId = text(snapshot.shopId ?? snapshot.shop_id ?? (isNumeric(userId) ? userId : metadata.id));
    const authenticated = snapshot.authenticated === true
        || snapshot.loggedIn === true
        || snapshot.isLogin === true
        || (metadata.status === 'authenticated' && Boolean(userId));
    return {
        authenticated,
        ...(shopId ? { shopId } : {}),
        ...(userId ? { userId } : {}),
        checkedAt,
    };
}
export function normalizeGoofishSession(value) {
    const item = asRow(value);
    // Goofish conversations can share a buyer id while having different product
    // contexts. The official session id, never the peer/buyer id, is the key.
    const id = text(item.sessionId ?? item.conversationId ?? item.cid ?? item.id)
        .replace(/@goofish$/i, '');
    if (!id)
        return undefined;
    const peer = asRow(item.peerUserInfo ?? item.userInfo ?? item.ownerInfo);
    const last = asRow(item.lastMessage ?? item.lastMsg ?? item.last_message);
    const title = text(item.title ?? item.sessionName ?? peer.nick ?? peer.nickname ?? peer.userName ?? peer.name)
        || text(item.userName ?? item.nickname ?? item.nick)
        || '闲鱼会话';
    const unreadCount = number(item.unreadCount ?? item.unread ?? item.unreadNum ?? item.unReadCount) ?? 0;
    const lastMessage = messageText(last.content ?? last.message ?? last.text ?? item.lastMessageText);
    const updatedAt = timestamp(item.updatedAt ?? item.updateTime ?? item.lastMessageTime ?? last.createTime ?? last.timestamp);
    const avatarUrl = text(item.avatarUrl ?? item.avatar ?? peer.avatar ?? peer.avatarUrl ?? peer.headImgUrl ?? peer.headPicUrl);
    return {
        id,
        title,
        unreadCount,
        ...(lastMessage ? { lastMessage } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
    };
}
export function normalizeGoofishMessage(value, context = {}) {
    const outer = asRow(value);
    const item = asRow(outer.message ?? outer.data ?? outer.payload ?? value);
    const contentModel = asRow(item.content ?? item.contentModel ?? item.content_model);
    const conversationId = text(item.conversationId ?? item.sessionId ?? item.cid ?? asRow(item.sessionInfo).sessionId ?? context.conversationId).replace(/@goofish$/i, '');
    const id = text(item.serverId ?? item.messageId ?? item.msgId ?? item.id ?? item.uuid);
    if (!conversationId || !id)
        return undefined;
    const sender = item.sender ?? item.from ?? item.senderInfo;
    const senderRow = asRow(sender);
    const senderId = text(item.senderId ?? item.fromId ?? senderRow.userId ?? senderRow.id ?? sender);
    const selfId = text(context.selfId);
    const explicitDirection = item.direction === 'inbound' || item.direction === 'outbound'
        ? item.direction
        : undefined;
    const direction = explicitDirection
        ?? (item.isMine === true || item.isSelf === true || (senderId && selfId && senderId === selfId) ? 'outbound' : 'inbound');
    const system = isSystemMessage(item, contentModel);
    const type = messageType(item, contentModel, system);
    const content = messageText(item.text ?? item.contentText ?? contentModel.text ?? contentModel.title ?? item.content);
    const receivedAt = context.receivedAt ?? timestamp(item.createTime ?? item.createdAt ?? item.timestamp) ?? Date.now();
    const explicitOrigin = originValue(item.origin ?? item.messageOrigin ?? item.source ?? item.sendSource);
    const manualEvidence = hasManualEvidence(item);
    let origin = 'unknown';
    if (system)
        origin = 'system';
    else if (context.sentByHook)
        origin = 'automation';
    else if (explicitOrigin)
        origin = explicitOrigin;
    else if (manualEvidence && direction === 'outbound')
        origin = 'human';
    else if (direction === 'inbound' && senderId && (!selfId || senderId !== selfId))
        origin = 'customer';
    const attachment = attachmentFrom(item, contentModel, type);
    const status = text(item.deliveryStatus ?? item.sendStatus ?? item.status).toLowerCase();
    const senderName = text(item.senderName ?? item.fromName ?? senderRow.nick ?? senderRow.nickname ?? senderRow.name);
    return {
        id,
        conversationId,
        ...(senderId ? { senderId } : {}),
        ...(senderName ? { senderName } : {}),
        content,
        type,
        direction,
        origin,
        deliveryStatus: /fail|error|失败/.test(status) ? 'failed' : /pending|sending|发送中/.test(status) ? 'pending' : 'sent',
        timestamp: timestamp(item.createTime ?? item.createdAt ?? item.timestamp ?? item.gmtCreate) ?? receivedAt,
        ...(attachment ? { attachments: [attachment] } : {}),
        raw: { source: text(item.source ?? item.sendSource ?? item.messageSource) || undefined, platformType: typeCode(item, contentModel) || undefined },
    };
}
export function normalizeGoofishProduct(value, fallbackShopId = '') {
    const item = asRow(value);
    const externalId = text(item.goodsId ?? item.itemId ?? item.item_id ?? item.id);
    if (!externalId)
        return undefined;
    const shopId = text(item.shopId ?? item.sellerId ?? item.userId) || fallbackShopId;
    const images = stringArray(item.images ?? item.pics ?? item.picUrlList ?? (item.img ? [item.img] : []));
    const skus = array(item.skus ?? item.skuList).map((value) => {
        const sku = asRow(value);
        const id = text(sku.skuId ?? sku.sku_id ?? sku.id);
        return {
            id: id || `${externalId}:default`,
            ...(id ? { externalId: id } : {}),
            name: text(sku.skuName ?? sku.sku_name ?? sku.name) || '默认',
            ...(number(sku.skuPrice ?? sku.sku_price ?? sku.price) !== undefined ? { price: { amount: number(sku.skuPrice ?? sku.sku_price ?? sku.price), currency: 'CNY' } } : {}),
            ...(number(sku.stockQuantity ?? sku.stock ?? sku.quantity) !== undefined ? { stockQuantity: number(sku.stockQuantity ?? sku.stock ?? sku.quantity) } : {}),
        };
    });
    const price = number(item.price ?? item.discountPrice ?? item.discount_price);
    const updatedAt = timestamp(item.updatedAt ?? item.sourceUpdatedAt ?? item.updateTime ?? item.modifiedAt);
    return {
        id: `goofish:${shopId || 'unknown'}:${externalId}`,
        externalId,
        title: text(item.title ?? item.name) || `闲鱼商品 ${externalId}`,
        ...(text(item.description ?? item.desc) ? { description: text(item.description ?? item.desc) } : {}),
        status: item.onSale === false ? 'off_sale' : 'on_sale',
        ...(price !== undefined ? { price: { amount: price, currency: 'CNY' } } : {}),
        ...(number(item.stockQuantity ?? item.quantity) !== undefined ? { stockQuantity: number(item.stockQuantity ?? item.quantity) } : {}),
        images,
        skus,
        ...(text(item.goodsUrl ?? item.itemUrl ?? item.url) ? { url: text(item.goodsUrl ?? item.itemUrl ?? item.url) } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        raw: { source: 'goofish-messaging', itemStatus: item.goodsStatus ?? item.status, shopId: shopId || undefined },
    };
}
export function asRow(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export function array(value) {
    if (Array.isArray(value))
        return value;
    const item = asRow(value);
    for (const key of ['rows', 'items', 'messages', 'sessions', 'data', 'list']) {
        if (Array.isArray(item[key]))
            return item[key];
    }
    return [];
}
export function text(value) {
    if (value == null)
        return '';
    if (typeof value === 'string' || typeof value === 'number')
        return String(value).trim();
    const item = asRow(value);
    return String(item.text ?? item.content ?? item.title ?? '').trim();
}
export function timestamp(value) {
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))) {
        const numeric = Number(value);
        return numeric > 0 && numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function number(value) {
    if (value === null || value === undefined || value === '')
        return undefined;
    const result = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return Number.isFinite(result) ? result : undefined;
}
function isNumeric(value) { return /^\d+$/.test(value); }
function messageText(value) {
    if (typeof value === 'string' || typeof value === 'number')
        return String(value);
    const item = asRow(value);
    const textModel = asRow(item.text);
    return text(value) || text(textModel.text) || text(item.summary) || text(item.description);
}
function typeCode(item, content) {
    return text(item.messageType ?? item.msgType ?? item.type ?? content.contentType ?? content.type).toLowerCase();
}
function messageType(item, content, system) {
    if (system)
        return 'system';
    const code = typeCode(item, content);
    if (['1', 'text', 'txt', 'plain'].includes(code))
        return 'text';
    if (['2', 'image', 'picture', 'photo'].includes(code))
        return 'image';
    if (['26', 'item', 'product', 'goods'].includes(code))
        return 'product';
    if (['system', 'notice', 'notification'].includes(code))
        return 'system';
    const pics = array(asRow(content.image).pics);
    if (pics.length || content.image || item.imageUrl)
        return 'image';
    return code ? 'unknown' : 'text';
}
function isSystemMessage(item, content) {
    const marker = text(item.originType ?? item.bizType ?? item.messageKind ?? item.msgKind ?? item.messageType ?? item.type).toLowerCase();
    const modelType = text(content.contentType ?? content.type).toLowerCase();
    return item.isSystem === true
        || item.system === true
        || item.isNotice === true
        || ['system', 'notice', 'notification', 'system_notice'].includes(marker)
        || ['system', 'notice', 'notification', 'system_notice'].includes(modelType);
}
function originValue(value) {
    const origin = text(value).toLowerCase();
    if (['customer', 'human', 'automation', 'system', 'unknown'].includes(origin))
        return origin;
    return undefined;
}
function hasManualEvidence(item) {
    const source = text(item.sendSource ?? item.messageSource ?? item.source ?? item.senderSource ?? item.operationSource).toLowerCase();
    return item.isManual === true
        || item.manualSend === true
        || item.fromManual === true
        || /(^|[._ -])(manual|human|staff)([._ -]|$)|人工|手动/.test(source);
}
function attachmentFrom(item, content, type) {
    const image = asRow(content.image);
    const firstImage = asRow(array(image.pics)[0]);
    const file = asRow(content.file ?? item.file);
    const url = text(firstImage.url ?? firstImage.src ?? image.url ?? item.imageUrl ?? item.fileUrl ?? file.url);
    const name = text(item.fileName ?? item.name ?? file.name);
    const mimeType = text(item.mimeType ?? file.mimeType ?? (type === 'image' ? 'image/*' : ''));
    if (!url && !name && !mimeType)
        return undefined;
    return { ...(url ? { url } : {}), ...(name ? { name } : {}), ...(mimeType ? { mimeType } : {}) };
}
function stringArray(value) {
    return array(value).map((entry) => typeof entry === 'string' ? entry : text(asRow(entry).url ?? asRow(entry).picUrl)).filter(Boolean);
}
//# sourceMappingURL=normalize.js.map