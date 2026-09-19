import type { EventEmitter } from 'node:events';

export interface GoofishAccountRecord {
  id: string;
  label: string;
  createdAt: string;
  status?: string;
  authenticatedAt?: string;
  userId?: string;
  nickname?: string;
  avatar?: string;
  partitionId?: string;
  partition: string;
  windowOpen: boolean;
}

export interface SendMessageInput {
  type?: 'text' | 'image' | 'emoji' | 'item' | 'product' | 'location' | string;
  content?: string | Record<string, unknown>;
  contentModel?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  options?: Record<string, unknown>;
  data?: string;
  name?: string;
  mime?: string;
  size?: number;
  [key: string]: unknown;
}

export interface GoofishEvent {
  accountId: string;
  eventType: 'bridge-ready' | 'page-loaded' | 'official-login-page' | 'sessions-changed' | 'session-opened' | 'message-added' | 'message-removed' | 'connection-changed' | 'connection-closed' | 'connection-error' | 'bridge-error' | 'load-error' | 'products-page-loading' | 'products-page-loaded' | 'products-page-data' | 'products-page-recovering' | 'products-list-complete' | 'products-detail-loading' | 'products-detail-loaded' | 'products-detail-error' | 'products-login-required' | 'products-login-complete' | 'products-loaded' | 'products-window-closed' | 'products-error' | string;
  payload: unknown;
}

export interface GoofishSkuItem {
  skuId: string;
  skuName: string;
  skuPrice: number;
}

/** Compatible with aichatclient's SyncGoodsItem shape. */
export interface GoofishProduct {
  id: string;
  goodsId: string;
  name: string;
  title?: string;
  price: number;
  originalPrice?: number;
  discountPrice?: number;
  stockQuantity?: number;
  stockStatus?: 'in_stock' | 'out_of_stock' | 'unknown';
  goodsStatus?: string;
  soldQuantity?: number;
  brandName?: string;
  categoryPath?: string[];
  shippingPolicy?: string;
  images: string[];
  goodsUrl: string;
  img?: string;
  shopId: string;
  platform: 'goofish' | string;
  platformEn?: string;
  createTime: string;
  editUrl: string;
  skuList: GoofishSkuItem[];
  description?: string;
  afterSalesPolicy?: string;
  sourceVersion?: string;
  sourceUpdatedAt?: string;
  attributes?: Record<string, unknown>;
  onSale?: boolean;
}

export interface ListProductsOptions {
  url?: string;
  waitForLogin?: boolean;
  timeout?: number;
  maxPages?: number;
  userId?: string;
}

export interface GoofishMessagingOptions {
  electron?: { BrowserWindow: unknown; session: unknown; app?: { getPath(name: string): string } };
  BrowserWindow?: unknown;
  session?: unknown;
  userDataPath?: string;
  accountsFileName?: string;
  logDirectory?: string | null;
  bridgePath?: string;
  pagePreloadPath?: string;
  partitionPrefix?: string;
  goofishUrl?: string;
  windowOptions?: Record<string, unknown>;
  commandTimeout?: number;
  enableDevShortcuts?: boolean;
  shouldKeepAccountAlive?: (accountId: string) => boolean;
  productUrl?: string;
}

export class GoofishMessagingClient extends EventEmitter {
  constructor(options?: GoofishMessagingOptions);
  listAccounts(): GoofishAccountRecord[];
  addAccount(input: { label?: string; show?: boolean; id: string }): GoofishAccountRecord;
  migrateAccount(accountId: string, nextAccountId: string): Promise<GoofishAccountRecord>;
  removeAccount(accountId: string): { removed: boolean; accountId: string };
  openAccount(accountId: string, show?: boolean): { opened: boolean; accountId: string };
  getEmbeddedWebviewConfig(accountId: string): { accountId: string; partition: string; preload: string; url: string };
  attachEmbeddedWebContents(accountId: string, webContents: unknown): Promise<unknown>;
  detachEmbeddedWebContents(accountId: string, webContents?: unknown): boolean;
  refreshAccount(accountId: string): { refreshed: boolean; accountId: string };
  snapshot(accountId: string): Promise<unknown>;
  listSessions(accountId: string): Promise<unknown>;
  openSession(accountId: string, sessionId: string): Promise<unknown>;
  listMessages(accountId: string, sessionId: string, options?: Record<string, unknown>): Promise<unknown>;
  loadMoreMessages(accountId: string, sessionId: string, fetchs?: number): Promise<unknown>;
  sendMessage(accountId: string, sessionId: string, message: string | SendMessageInput): Promise<unknown>;
  sendText(accountId: string, sessionId: string, text: string, options?: SendMessageInput): Promise<unknown>;
  sendImage(accountId: string, sessionId: string, image: SendMessageInput): Promise<unknown>;
  sendMapCard(accountId: string, sessionId: string, card: { title?: string; subtitle?: string; map_card_title?: string; map_card_subtitle?: string; latitude?: number; longitude?: number; address?: string }): Promise<unknown>;
  listOnSaleProducts(accountId: string, options?: ListProductsOptions): Promise<GoofishProduct[]>;
  listProducts(accountId: string, options?: ListProductsOptions): Promise<GoofishProduct[]>;
  openProducts(accountId: string, url?: string): { opened: boolean; accountId: string; url: string };
  closeProducts(accountId: string): { closed: boolean; accountId: string };
  handlePageMessage(sender: unknown, data: unknown): boolean;
  closeAll(): void;
  releaseIdleAccounts(): void;
  restoreAccounts(options?: { openWindows?: boolean }): Promise<void>;
  dispose(): void;
  on(event: 'event', listener: (event: GoofishEvent) => void): this;
}

export class GoofishAccount extends EventEmitter {}
export class GoofishProductCatalog extends EventEmitter {
  constructor(options?: Record<string, unknown>);
  listOnSaleProducts(options?: ListProductsOptions): Promise<GoofishProduct[]>;
  open(show?: boolean, url?: string): { opened: boolean; accountId: string; url: string };
  close(): void;
}
export class JsonAccountRepository {}
export class NdjsonLogger {}
export function createIpcChannels(prefix?: string): Record<string, string>;
export function registerGoofishIpc(client: GoofishMessagingClient, options?: Record<string, unknown>): { channels: Record<string, string>; dispose(): void };
export function normalizeProductCard(raw: Record<string, unknown>, context?: { accountId?: string; userId?: string }): GoofishProduct | null;
export function normalizeProductDetail(payload: Record<string, unknown>, product: GoofishProduct, context?: { accountId?: string; userId?: string }): GoofishProduct | null;
export const PRODUCT_LIST_API: string;
export const PRODUCT_DETAIL_API: string;
