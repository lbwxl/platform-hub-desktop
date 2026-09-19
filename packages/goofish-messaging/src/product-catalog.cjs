const { EventEmitter } = require('node:events');
const { GOOFISH_PERSONAL_URL, OFFICIAL_LOGIN_HOSTS } = require('./constants.cjs');
const { hostMatches, installSinglePopupHandler, partitionFor, registerWindowShortcuts } = require('./utils.cjs');

const PRODUCT_LIST_API = 'mtop.idle.web.xyh.item.list';
const PRODUCT_DETAIL_API = 'mtop.taobao.idle.pc.detail';
const LOGIN_REQUIRED_TEXT = ['登录后可以更懂你', '立即登录'];
const SOLD_STATUS = new Set([1, -2, '1', '-2', 'sold', 'offShelf', 'offshelf']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function numberValue(value) {
  if (value && typeof value === 'object') {
    const object = asRecord(value);
    const integer = firstValue(object.integer, object.value, object.amount, object.price);
    const decimal = firstValue(object.decimal, object.fraction, object.cent);
    if (integer !== undefined && decimal !== undefined) {
      const parsedInteger = Number(integer);
      const parsedDecimal = String(decimal).replace(/^0\./, '').replace(/^\./, '');
      if (Number.isFinite(parsedInteger) && parsedDecimal) return Number(`${parsedInteger}.${parsedDecimal}`);
    }
    value = integer;
  }
  const parsed = Number(String(value ?? '').replace(/[￥¥,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumberValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = numberValue(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstImage(raw) {
  const images = firstValue(
    raw.images,
    raw.picUrlList,
    raw.pics,
    raw.picInfo?.picUrlList,
    raw.cardData?.picInfo?.picUrlList,
    raw.itemInfo?.pics,
  );
  if (Array.isArray(images)) {
    const urls = images.map((item) => textValue(typeof item === 'object' ? firstValue(item.url, item.picUrl, item.src) : item)).filter(Boolean);
    if (urls.length) return urls;
  }
  const single = firstValue(
    raw.mainPicUrl,
    raw.picUrl,
    raw.image,
    raw.cardData?.picInfo?.picUrl,
    raw.itemInfo?.mainPic,
    raw.itemInfo?.mainPicUrl,
  );
  return single ? [textValue(single)] : [];
}

function itemIdOf(raw) {
  return textValue(firstValue(
    raw.itemId,
    raw.item_id,
    raw.id,
    raw.cardData?.id,
    raw.cardData?.itemId,
    raw.itemInfo?.itemId,
  ));
}

function titleOf(raw) {
  return textValue(firstValue(
    raw.title,
    raw.itemTitle,
    raw.cardData?.title,
    raw.itemInfo?.title,
    raw.data?.title,
  ));
}

function statusOf(raw) {
  return firstValue(raw.itemStatus, raw.status, raw.cardData?.itemStatus, raw.itemInfo?.itemStatus);
}

function productUrlOf(raw, itemId) {
  const url = firstValue(raw.itemUrl, raw.goodsUrl, raw.url, raw.cardData?.itemUrl, raw.cardData?.url);
  if (url) return textValue(url);
  return itemId ? `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}` : '';
}

function normalizeProductCard(raw, { accountId, userId = '' } = {}) {
  const source = asRecord(raw);
  const goodsId = itemIdOf(source);
  if (!goodsId) return null;
  const images = firstImage(source).map((url) => url.replace(/^http:/, 'https:'));
  const price = numberValue(firstValue(
    source.price,
    source.priceInfo?.price,
    source.cardData?.price,
    source.cardData?.priceInfo?.price,
    source.cardData?.detailParams?.soldPrice,
    source.itemInfo?.price,
    source.data?.price,
  ));
  const explicitShopId = firstValue(
    source.sellerId,
    source.seller?.sellerId,
    source.seller?.userId,
    source.userId,
  );
  const shopId = textValue(firstValue(explicitShopId, userId));
  if (!shopId) return null;
  const status = statusOf(source);
  const statusText = textValue(firstValue(source.statusText, source.itemStatusText, source.cardData?.statusText));
  const sold = SOLD_STATUS.has(status) || /已售出|已下架|交易关闭|违规|不可售/.test(statusText);
  const name = titleOf(source) || `闲鱼商品 ${goodsId}`;
  return {
    id: `goofish;${shopId};${goodsId}`,
    goodsId,
    name,
    title: name,
    price,
    images,
    img: images[0] || '',
    goodsUrl: productUrlOf(source, goodsId),
    shopId,
    platform: 'goofish',
    platformEn: 'goofish',
    createTime: textValue(firstValue(source.createTime, source.publishTime, source.createdAt, source.cardData?.createTime)),
    editUrl: productUrlOf(source, goodsId),
    skuList: Array.isArray(source.skus) ? source.skus.map((sku) => ({
      skuId: textValue(firstValue(sku?.skuId, sku?.sku_id, sku?.id)),
      skuName: textValue(firstValue(sku?.skuName, sku?.sku_name, sku?.name)),
      skuPrice: numberValue(firstValue(sku?.skuPrice, sku?.sku_price, sku?.price)),
    })) : [],
    description: textValue(firstValue(source.description, source.desc, source.cardData?.description)),
    afterSalesPolicy: textValue(firstValue(source.afterSalesPolicy, source.after_sales_policy)),
    attributes: {
      itemStatus: status ?? 0,
      statusText,
      source: source,
    },
    onSale: !sold,
  };
}

function normalizeProductDetail(payload, product, { accountId, userId = '' } = {}) {
  const data = dataFromPayload(payload);
  const item = asRecord(data.itemDO);
  const seller = asRecord(data.sellerDO);
  const category = asRecord(item.itemCatDTO);
  const itemId = textValue(firstValue(item.itemId, product?.goodsId));
  if (!itemId || (product?.goodsId && itemId !== String(product.goodsId))) return null;

  const images = firstImage({ images: item.imageInfos }).map((url) => url.replace(/^http:/, 'https:'));
  const price = optionalNumberValue(firstValue(item.soldPrice, product?.price)) ?? 0;
  const originalPriceValue = optionalNumberValue(item.originalPrice);
  const originalPrice = originalPriceValue && originalPriceValue > 0 ? originalPriceValue : undefined;
  const stockQuantity = optionalNumberValue(item.quantity);
  const itemStatus = firstValue(item.itemStatus, product?.attributes?.itemStatus);
  const goodsStatus = textValue(firstValue(item.itemStatusStr, product?.attributes?.statusText));
  const unavailable = SOLD_STATUS.has(itemStatus) || /已售出|已下架|交易关闭|违规|不可售/.test(goodsStatus);
  const stockStatus = unavailable || stockQuantity === 0 ? 'out_of_stock' : stockQuantity === undefined ? 'unknown' : 'in_stock';
  const categoryPath = [
    category.rootChannelCatId,
    category.level2ChannelCatId,
    category.level3ChannelCatId,
    category.channelCatId,
    firstValue(category.catId, item.categoryId),
  ].map(textValue).filter((value, index, values) => value && values.indexOf(value) === index);
  const transportFee = optionalNumberValue(item.transportFee);
  const shippingPolicy = transportFee === undefined ? undefined : transportFee === 0 ? '包邮' : `运费 ${transportFee} 元`;
  const serviceDescriptions = Array.isArray(item.uiItemServiceDOList) ? item.uiItemServiceDOList.map((service) => textValue(firstValue(
    service?.title,
    service?.name,
    service?.text,
    service?.desc,
  ))).filter(Boolean) : [];
  const explicitShopId = textValue(firstValue(
    seller.sellerId,
    data.trackParams?.sellerId,
  ));
  const productShopId = textValue(product?.shopId);
  const candidateShopId = textValue(firstValue(explicitShopId, productShopId, userId));
  const shopId = candidateShopId;
  if (!shopId) return null;
  const title = textValue(firstValue(item.title, product?.name)) || `闲鱼商品 ${itemId}`;
  const description = textValue(firstValue(item.desc, richTextDescription(item.richTextDesc), product?.description));
  const labels = Array.isArray(item.itemLabelExtList)
    ? item.itemLabelExtList.map((label) => ({
      property: textValue(firstValue(label?.propertyText, label?.propertyName)),
      value: textValue(firstValue(label?.valueText, label?.valueName, label?.text)),
    })).filter((label) => label.property || label.value)
    : [];
  const categoryId = textValue(firstValue(item.categoryId, category.catId));
  const goodsUrl = `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`;

  return {
    ...product,
    id: `goofish;${shopId};${itemId}`,
    goodsId: itemId,
    name: title,
    title,
    price,
    originalPrice,
    discountPrice: originalPrice && originalPrice > price ? price : undefined,
    stockQuantity,
    stockStatus,
    goodsStatus,
    soldQuantity: optionalNumberValue(item.soldCnt),
    categoryPath,
    shippingPolicy,
    images: images.length ? images : (product?.images || []),
    img: images[0] || product?.img || '',
    goodsUrl,
    editUrl: goodsUrl,
    shopId,
    createTime: textValue(firstValue(item.GMT_CREATE_DATE_KEY, item.gmtCreate, product?.createTime)),
    description,
    afterSalesPolicy: serviceDescriptions.join('；') || product?.afterSalesPolicy,
    sourceVersion: PRODUCT_DETAIL_API,
    sourceUpdatedAt: textValue(data.serverTime),
    attributes: {
      ...asRecord(product?.attributes),
      itemStatus,
      statusText: goodsStatus,
      detail: {
        browseCount: optionalNumberValue(item.browseCnt),
        favoriteCount: optionalNumberValue(firstValue(item.collectCnt, item.favorCnt)),
        wantedCount: optionalNumberValue(item.wantCnt),
        itemType: item.itemType,
        categoryIds: categoryPath,
        transportFee,
        labels,
        seller: {
          sellerId: shopId,
          nick: textValue(seller.nick),
          city: textValue(firstValue(seller.publishCity, seller.city)),
        },
      },
    },
    onSale: !unavailable,
  };
}

function parseJsonBody(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch (_) {}
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

function dataFromPayload(payload) {
  return asRecord(payload?.data);
}

function richTextDescription(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const root = JSON.parse(value);
    const texts = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.text === 'string' && node.text.trim()) texts.push(node.text.trim());
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(root);
    return texts.join('\n').trim();
  } catch (_) {
    return '';
  }
}

function isNavigationAbort(error) {
  return error?.code === 'ERR_ABORTED' || error?.errno === -3;
}

function timeoutMessage(run) {
  if (run?.loginRequired || !run?.received) {
    return '获取闲鱼商品超时，请确认已完成官方登录';
  }
  if (run?.finishing) {
    return `闲鱼商品详情采集长时间无进展（已发现 ${run.products?.size || 0} 件），请重试`;
  }
  return `闲鱼商品分页采集长时间无进展（已读取 ${run?.products?.size || 0} 件，闲鱼仍显示有下一页），请重试`;
}

class GoofishProductCatalog extends EventEmitter {
  constructor(options = {}) {
    super();
    const {
      account,
      BrowserWindow,
      session,
      logger,
      partitionPrefix = 'goofish-messaging',
      productUrl = GOOFISH_PERSONAL_URL,
      commandTimeout = 120_000,
      enableDevShortcuts = false,
      windowOptions = {},
    } = options;
    if (!account?.id) throw new TypeError('GoofishProductCatalog 需要有效的 account');
    if (!BrowserWindow || !session) throw new TypeError('GoofishProductCatalog 需要 Electron BrowserWindow 和 session');
    this.account = { ...account };
    this.BrowserWindow = BrowserWindow;
    this.electronSession = session;
    this.logger = logger;
    this.partitionPrefix = partitionPrefix;
    this.productUrl = productUrl;
    this.commandTimeout = commandTimeout;
    this.enableDevShortcuts = enableDevShortcuts;
    this.windowOptions = windowOptions;
    this.window = null;
    this.popupController = null;
    this.debuggerAttached = false;
    this.debuggerMessageHandler = null;
    this.debuggerPromise = null;
    this.run = null;
  }

  get id() { return this.account.id; }
  get partition() { return partitionFor(this.account.partitionId || this.id, this.partitionPrefix); }

  describe() {
    return { accountId: this.id, partition: this.partition, windowOpen: Boolean(this.window && !this.window.isDestroyed()), url: this.productUrl };
  }

  updateAccount(account) {
    if (!account?.id) throw new Error('账号标识不匹配');
    this.account = { ...account };
  }

  emitEvent(eventType, payload = {}) {
    const event = { accountId: this.id, eventType, payload };
    this.emit('event', event);
    this.logger?.write('products', event);
    return event;
  }

  armInactivityTimeout(run) {
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => {
      if (this.run === run) this.rejectRun(new Error(timeoutMessage(run)));
    }, run.inactivityTimeout);
  }

  markProgress(run) {
    if (this.run !== run) return;
    run.lastProgressAt = Date.now();
    this.armInactivityTimeout(run);
  }

  scrollForNextPage(run) {
    if (this.run !== run || run.scrolling || !run.hasMore) return;
    run.scrolling = true;
    this.window?.webContents.executeJavaScript(`(() => {
      const root = document.scrollingElement || document.documentElement;
      const candidates = [root, ...document.querySelectorAll('*')]
        .filter((element, index, items) => element && items.indexOf(element) === index)
        .filter((element) => element.scrollHeight > element.clientHeight + 8);
      for (const element of candidates) {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, root?.scrollHeight || 0));
      return candidates.length;
    })()`, true)
      .finally(() => {
        if (this.run === run) run.scrolling = false;
      })
      .catch(() => {});
  }

  isGoofishUrl(rawUrl) { return hostMatches(rawUrl, ['goofish.com']); }

  attachDebugger(window) {
    const setup = (async () => {
      const debuggerApi = window.webContents.debugger;
      if (debuggerApi.isAttached()) debuggerApi.detach();
      debuggerApi.attach('1.3');
      this.debuggerAttached = true;
      this.debuggerMessageHandler = (_event, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const responseUrl = params?.response?.url || '';
        if (!responseUrl.includes(PRODUCT_LIST_API) && !responseUrl.includes(PRODUCT_DETAIL_API)) return;
        const run = this.run;
        this.readResponseBody(debuggerApi, params.requestId, responseUrl, run).catch((error) => {
          this.emitEvent('products-error', { message: error.message, url: responseUrl });
        });
      };
      debuggerApi.on('message', this.debuggerMessageHandler);
      await debuggerApi.sendCommand('Network.enable');
      await debuggerApi.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
    })();
    this.debuggerPromise = setup;
    setup.finally(() => {
      if (this.debuggerPromise === setup) this.debuggerPromise = null;
    }).catch(() => {});
    return setup;
  }

  detachDebugger() {
    const debuggerApi = this.window?.webContents?.debugger;
    if (debuggerApi && this.debuggerMessageHandler) debuggerApi.removeListener('message', this.debuggerMessageHandler);
    this.debuggerMessageHandler = null;
    if (debuggerApi?.isAttached()) debuggerApi.detach();
    this.debuggerAttached = false;
  }

  createWindow() {
    const accountSession = this.electronSession.fromPartition(this.partition, { cache: true });
    const customWebPreferences = this.windowOptions.webPreferences || {};
    const window = new this.BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      title: `闲鱼商品 - ${this.account.label}`,
      show: false,
      autoHideMenuBar: true,
      ...this.windowOptions,
      skipTaskbar: true,
      webPreferences: {
        ...customWebPreferences,
        session: accountSession,
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
      },
    });
    window.setSkipTaskbar?.(true);
    window.on('show', () => window.setSkipTaskbar?.(true));
    window.on('close', (event) => {
      if (!window.__goofishForceClose) {
        event.preventDefault();
        window.hide();
      }
    });
    if (this.enableDevShortcuts) registerWindowShortcuts(window);
    this.popupController?.dispose();
    this.popupController = installSinglePopupHandler(window, {
      isAllowed: (url) => hostMatches(url, OFFICIAL_LOGIN_HOSTS),
      browserWindowOptions: {
        width: 920,
        height: 720,
        skipTaskbar: true,
        autoHideMenuBar: true,
        parent: window,
        webPreferences: { session: accountSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
      },
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.emitEvent('products-page-loading', { url: _url });
    });
    window.webContents.on('did-finish-load', () => this.emitEvent('products-page-loaded', { url: window.webContents.getURL() }));
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) this.emitEvent('products-error', { code, description, url });
    });
    window.on('closed', () => {
      this.popupController?.dispose();
      this.popupController = null;
      this.detachDebugger();
      if (this.window === window) this.window = null;
      this.rejectRun(new Error('闲鱼商品窗口已关闭'));
      this.emitEvent('products-window-closed');
    });
    this.window = window;
    return window;
  }

  ensureWindow() {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createWindow();
    }
    return this.window;
  }

  open(show = true, url = this.productUrl) {
    const window = this.ensureWindow();
    if (url && window.webContents.getURL() !== url) window.loadURL(url).catch((error) => this.emitEvent('products-error', { message: error.message, url }));
    window.setSkipTaskbar?.(true);
    if (show) { window.show(); window.focus(); }
    else window.hide();
    return { opened: true, accountId: this.id, url };
  }

  async pageSnapshot() {
    const window = this.ensureWindow();
    try {
      return await window.webContents.executeJavaScript(`(() => {
        const text = document.body?.innerText || '';
        return {
          href: location.href,
          title: document.title,
          loginRequired: ${JSON.stringify(LOGIN_REQUIRED_TEXT)}.some((item) => text.includes(item)) || /\\/login(?:[?#]|$)/.test(location.href),
          text: text.slice(0, 500),
        };
      })()`, true);
    } catch (error) {
      return { href: '', title: '', loginRequired: true, text: error.message };
    }
  }

  async readResponseBody(debuggerApi, requestId, url, run = this.run) {
    if (!run || this.run !== run) return;
    let result;
    for (const delay of [0, 100, 400, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try { result = await debuggerApi.sendCommand('Network.getResponseBody', { requestId }); break; } catch (_) {}
    }
    if (!result) return;
    const payload = parseJsonBody(result.body);
    const data = dataFromPayload(payload);
    const ret = Array.isArray(payload?.ret) ? payload.ret.join(';') : '';
    if (this.run !== run) return;
    if (url.includes(PRODUCT_DETAIL_API)) {
      this.handleDetailPayload(payload, url, run);
      return;
    }
    if (/login|未登录|授权|session|FAIL_SYS/.test(ret) && !data.cardList) {
      run.loginRequired = true;
      this.emitLoginRequired();
      return;
    }
    if (!Array.isArray(data.cardList)) return;
    run.loginRequired = false;
    run.received = true;
    const userId = textValue(firstValue(data.userId, data.kcUserId, data.baseInfo?.userId, run.userId));
    if (userId) run.userId = userId;
    const previousCollectedCount = run.products.size;
    let normalizedCount = 0;
    let onSaleCount = 0;
    for (const raw of data.cardList) {
      const product = normalizeProductCard(raw, { accountId: this.id, userId: run.userId });
      if (product) normalizedCount += 1;
      if (product?.onSale) {
        onSaleCount += 1;
        run.products.set(product.goodsId, product);
      }
    }
    run.hasMore = Boolean(data.nextPage || data.hasMore);
    run.nextPageModel = data.nextPageModel;
    run.nextPageNum = data.nextPageNum;
    run.lastPageCount = data.cardList.length;
    const uniqueAddedCount = run.products.size - previousCollectedCount;
    const reportedTotal = optionalNumberValue(firstValue(
      data.totalCount,
      data.total,
      data.itemCount,
      data.totalItemCount,
      data.pageInfo?.totalCount,
    ));
    if (reportedTotal !== undefined && reportedTotal >= run.products.size) {
      run.totalCount = reportedTotal;
    }
    this.emitEvent('products-page-data', {
      url,
      count: data.cardList.length,
      normalizedCount,
      onSaleCount,
      collectedCount: run.products.size,
      uniqueAddedCount,
      totalCount: run.totalCount,
      hasMore: run.hasMore,
    });
    if (uniqueAddedCount > 0 || !run.hasMore) {
      run.stallRecoveries = 0;
      this.markProgress(run);
    }
    this.maybeFinish({ pageReceived: true });
  }

  handleDetailPayload(payload, url, run) {
    const waiter = run?.detailWaiter;
    if (!waiter) return;
    const product = normalizeProductDetail(payload, waiter.product, { accountId: this.id, userId: run.userId });
    if (!product) return;
    clearTimeout(waiter.timeout);
    run.detailWaiter = null;
    this.emitEvent('products-detail-loaded', {
      goodsId: product.goodsId,
      imageCount: product.images.length,
      hasDescription: Boolean(product.description),
      url,
    });
    this.markProgress(run);
    waiter.resolve(product);
  }

  emitLoginRequired() {
    if (!this.run || this.run.loginEventEmitted) return;
    this.run.loginEventEmitted = true;
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
    }
    this.emitEvent('products-login-required', { url: this.productUrl, message: '请在打开的闲鱼官方页面完成登录，登录后将自动继续获取在售商品' });
  }

  rejectRun(error) {
    if (!this.run) return;
    clearTimeout(this.run.timeout);
    clearInterval(this.run.poller);
    clearInterval(this.run.scroller);
    const current = this.run;
    this.run = null;
    if (current.detailWaiter) {
      clearTimeout(current.detailWaiter.timeout);
      current.detailWaiter.reject(error);
      current.detailWaiter = null;
    }
    current.reject(error);
  }

  maybeFinish({ pageReceived = false } = {}) {
    if (!this.run || !this.run.received || this.run.loginRequired) return;
    // 只有收到新的列表响应才能推进分页。登录状态轮询只负责恢复登录，
    // 不能重复增加页码，否则列表仍有下一页时也会提前达到 maxPages。
    if (this.run.hasMore) {
      if (!pageReceived || this.run.loadingNextPage) return;
      if (this.run.page >= this.run.maxPages) {
        return this.rejectRun(new Error(`闲鱼商品超过最大采集页数 ${this.run.maxPages}，请提高 maxPages 后重试`));
      }
      this.run.page += 1;
      this.run.loadingNextPage = true;
      this.scrollForNextPage(this.run);
      this.run.loadingNextPage = false;
      return;
    }
    if (this.run.finishing) return;
    this.run.finishing = true;
    this.run.listComplete = true;
    this.emitEvent('products-list-complete', {
      collectedCount: this.run.products.size,
      lastPageCount: this.run.lastPageCount,
      hasMore: false,
    });
    clearTimeout(this.run.timeout);
    clearInterval(this.run.poller);
    clearInterval(this.run.scroller);
    this.enrichAndFinish(this.run).catch((error) => this.rejectRun(error));
  }

  loadProductDetail(product, run) {
    return new Promise((resolve, reject) => {
      const detailUrl = product.goodsUrl || `https://www.goofish.com/item?id=${encodeURIComponent(product.goodsId)}`;
      const timeout = setTimeout(() => {
        if (run.detailWaiter?.product?.goodsId === product.goodsId) run.detailWaiter = null;
        reject(new Error(`获取商品 ${product.goodsId} 详情超时`));
      }, Math.min(30_000, this.commandTimeout));
      run.detailWaiter = { product, resolve, reject, timeout };
      this.emitEvent('products-detail-loading', { goodsId: product.goodsId, url: detailUrl });
      this.window.loadURL(detailUrl).catch((error) => {
        if (isNavigationAbort(error)) return;
        if (run.detailWaiter?.product?.goodsId === product.goodsId) run.detailWaiter = null;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async enrichAndFinish(run) {
    const products = [...run.products.values()];
    for (const product of products) {
      if (this.run !== run) return;
      try {
        const detailed = await this.loadProductDetail(product, run);
        run.products.set(product.goodsId, detailed);
      } catch (error) {
        this.emitEvent('products-detail-error', {
          goodsId: product.goodsId,
          message: error.message,
          fallback: 'list-summary',
        });
        this.markProgress(run);
      }
    }
    if (this.run !== run) return;
    const detailedProducts = [...run.products.values()];
    this.run = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    this.emitEvent('products-loaded', {
      count: detailedProducts.length,
      products: detailedProducts,
      listComplete: run.listComplete === true,
    });
    run.resolve(detailedProducts);
  }

  async listOnSaleProducts({ url = this.productUrl, waitForLogin = true, timeout = this.commandTimeout, maxPages = 1000, userId } = {}) {
    const window = this.ensureWindow();
    if (this.run) return this.run.promise;
    const run = {};
    run.promise = new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });
    run.products = new Map();
    run.page = 1;
    run.maxPages = Math.max(1, Number(maxPages) || 20);
    run.received = false;
    run.loginRequired = false;
    run.userId = textValue(firstValue(userId, this.account.userId));
    run.hasMore = false;
    run.totalCount = undefined;
    run.loadingNextPage = false;
    run.loginEventEmitted = false;
    run.finishing = false;
    run.detailWaiter = null;
    run.listComplete = false;
    run.lastPageCount = 0;
    run.inactivityTimeout = Math.max(10_000, Number(timeout) || this.commandTimeout);
    run.lastProgressAt = Date.now();
    run.lastRecoveryAt = 0;
    run.stallRecoveries = 0;
    run.scrolling = false;
    this.run = run;
    this.armInactivityTimeout(run);
    const promise = run.promise;
    try {
      // A fresh Electron WebContents may not finish debugger domain setup before its first navigation.
      if (!window.webContents.getURL()) await window.loadURL('about:blank');
      if (!this.debuggerAttached && !this.debuggerPromise) this.attachDebugger(window);
      if (this.debuggerPromise) await this.debuggerPromise;
      if (url) {
        try {
          await window.loadURL(url);
        } catch (error) {
          if (!isNavigationAbort(error)) throw error;
        }
      }
      const snapshot = await this.pageSnapshot();
      if (this.run !== run) return promise;
      if (snapshot.loginRequired) {
        run.loginRequired = true;
        this.emitLoginRequired();
        if (!waitForLogin) {
          this.rejectRun(new Error('闲鱼尚未登录，请先在商品窗口完成官方登录'));
          return promise;
        }
      }
    } catch (error) {
      this.rejectRun(error);
      return promise;
    }
    if (!this.run) return promise;
    if (run.loginRequired) {
      this.emitLoginRequired();
    }
    run.poller = setInterval(async () => {
      if (this.run !== run) return;
      const current = await this.pageSnapshot();
      if (this.run !== run) return;
      if (current.loginRequired) {
        run.loginRequired = true;
        this.emitLoginRequired();
      } else if (run.loginRequired) {
        run.loginRequired = false;
        run.loginEventEmitted = false;
        this.emitEvent('products-login-complete', { url: current.href });
        this.markProgress(run);
        if (window && !window.isDestroyed()) window.hide();
        if (!run.received) window.reload();
      }
      this.maybeFinish();
    }, 1000);
    run.scroller = setInterval(() => {
      if (this.run !== run || !run.hasMore || run.page >= run.maxPages) return;
      this.scrollForNextPage(run);
      const now = Date.now();
      if (now - run.lastProgressAt < 12_000 || now - run.lastRecoveryAt < 12_000) return;
      run.lastRecoveryAt = now;
      run.stallRecoveries += 1;
      this.emitEvent('products-page-recovering', {
        collectedCount: run.products.size,
        attempt: run.stallRecoveries,
        message: '闲鱼商品分页暂无进展，正在自动恢复',
      });
      // 闲鱼个人页偶尔会在二次同步时停止触发无限滚动。保留已采集
      // 商品并重载官方列表页，让后续响应继续去重采集，直至 hasMore=false。
      run.page = 1;
      window.reload();
    }, 1800);
    return promise;
  }

  close() {
    this.rejectRun(new Error('闲鱼商品目录已关闭'));
    this.detachDebugger();
    this.popupController?.dispose();
    this.popupController = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.__goofishForceClose = true;
      this.window.destroy();
    }
    this.window = null;
  }
}

module.exports = { GoofishProductCatalog, normalizeProductCard, normalizeProductDetail, PRODUCT_LIST_API, PRODUCT_DETAIL_API };
