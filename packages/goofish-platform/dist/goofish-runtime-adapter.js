import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { GoofishMessagingClient } from '@idle-fish/goofish-messaging';
import { GoofishTransport } from '@platform-hub/goofish-transport';
const DEFINITION = {
    id: 'goofish',
    label: '闲鱼',
    url: 'https://www.goofish.com/im',
    executionModel: 'native',
    capabilities: ['messages.listen', 'messages.history', 'messages.send', 'messages.file', 'sessions.list', 'products.collect', 'products.detail'],
    version: '1.0.0',
};
/** All Goofish account, migration, transport and visible-view ownership stays here. */
export class GoofishRuntimeFactory {
    userDataPath;
    definition = DEFINITION;
    client;
    contexts = new Map();
    constructor(userDataPath = app.getPath('userData')) {
        this.userDataPath = userDataPath;
        this.client = new GoofishMessagingClient({
            electron: { BrowserWindow, session, app },
            userDataPath,
            partitionPrefix: 'goofish-messaging',
            shouldKeepAccountAlive: (clientAccountId) => [...this.contexts.values()].some((context) => {
                const account = context.getAccount?.();
                return account?.online === true && String(account.adapterMetadata?.clientAccountId || '') === clientAccountId;
            }),
        });
    }
    async prepareAccount(account) {
        const legacyId = stringValue(account.adapterMetadata?.clientAccountId ?? account.goofishClientAccountId);
        const existing = this.findClientAccount(legacyId, account.partition);
        const clientAccount = existing || this.client.addAccount({ id: legacyId || temporaryAccountId(), label: account.label, show: false });
        const config = this.client.getEmbeddedWebviewConfig(clientAccount.id);
        const adapterMetadata = { ...(account.adapterMetadata || {}), clientAccountId: String(clientAccount.id) };
        delete account.goofishClientAccountId;
        return { url: config.url, partition: config.partition, adapterMetadata };
    }
    create(account, context) {
        const clientAccountId = String(account.adapterMetadata?.clientAccountId || this.ensureClientAccount(account).id);
        const adapter = new GoofishRuntimeAdapter(account, clientAccountId, context, this.client);
        this.contexts.set(account.id, context);
        return adapter;
    }
    async removeAccount(account) {
        this.contexts.delete(account.id);
        const clientAccountId = String(account.adapterMetadata?.clientAccountId || '');
        if (clientAccountId) {
            try {
                this.client.removeAccount(clientAccountId);
            }
            catch { /* already removed or migrated */ }
        }
    }
    async dispose() {
        this.contexts.clear();
        this.client.dispose();
    }
    findClientAccount(clientId, partition) {
        const accounts = this.client.listAccounts().map(asRecord).filter((item) => typeof item.id === 'string');
        const byId = clientId ? accounts.find((item) => String(item.id) === clientId) : undefined;
        if (byId)
            return byId;
        return accounts.find((item) => {
            try {
                return this.client.getEmbeddedWebviewConfig(String(item.id)).partition === partition;
            }
            catch {
                return false;
            }
        });
    }
    ensureClientAccount(account) {
        const found = this.findClientAccount(String(account.adapterMetadata?.clientAccountId || ''), account.partition);
        if (found)
            return found;
        return this.client.addAccount({ id: temporaryAccountId(), label: account.label, show: false });
    }
}
export class GoofishRuntimeAdapter {
    account;
    context;
    client;
    transport;
    view = null;
    viewLoad;
    attachedWindow = null;
    clientAccountId;
    started = false;
    disposed = false;
    clientListener;
    constructor(account, clientAccountId, context, client) {
        this.account = account;
        this.context = context;
        this.client = client;
        this.clientAccountId = clientAccountId;
        const goofishTransport = new GoofishTransport({ accountId: account.id, clientAccountId, client });
        this.transport = new GoofishAdapterTransport(goofishTransport);
        this.clientListener = (event) => this.onClientEvent(event);
    }
    get id() { return this.account.id; }
    async start() {
        if (this.disposed)
            throw new Error('闲鱼 Runtime 已释放');
        if (this.started)
            return;
        this.client.on('event', this.clientListener);
        try {
            const view = this.ensureView();
            await this.waitForPrimary(view);
            await this.transport.start();
            this.started = true;
            this.context.updateAccount({ connected: true, webContentsId: view.webContents.id });
        }
        catch (error) {
            this.client.removeListener('event', this.clientListener);
            throw error;
        }
    }
    async stop() {
        await this.transport.stop();
        this.client.removeListener('event', this.clientListener);
        this.started = false;
    }
    async getStatus() {
        await this.start();
        const result = await this.transport.invoke('auth.state', {});
        if (!result.ok)
            throw new Error(result.error.message);
        const auth = asRecord(result.data);
        const view = this.view;
        const status = {
            connected: Boolean(view && !view.webContents.isDestroyed()),
            authenticated: auth.authenticated === true,
            url: view?.webContents.getURL() || this.account.url,
            title: view?.webContents.getTitle(),
            message: auth.authenticated === true ? '闲鱼已登录，Runtime 已就绪' : '请在当前闲鱼官方页面完成登录',
            webContentsId: view && !view.webContents.isDestroyed() ? view.webContents.id : undefined,
        };
        this.context.updateAccount({ connected: status.connected, authenticated: status.authenticated, webContentsId: status.webContentsId });
        return status;
    }
    async attachPrimaryView() {
        await this.start();
        const host = this.context.getHostWindow();
        if (!host || host.isDestroyed())
            throw new Error('主工作台窗口尚未就绪');
        const view = this.view;
        if (!view || view.webContents.isDestroyed())
            throw new Error('闲鱼页面尚未创建');
        if (this.attachedWindow !== host) {
            this.detachPrimaryView();
            host.contentView.addChildView(view);
            this.attachedWindow = host;
        }
        view.setVisible(true);
        const bounds = this.context.getPrimaryViewBounds();
        if (bounds)
            view.setBounds(bounds);
    }
    detachPrimaryView() {
        const view = this.view;
        const host = this.attachedWindow;
        if (view && host && !host.isDestroyed()) {
            try {
                host.contentView.removeChildView(view);
            }
            catch { /* already detached */ }
        }
        if (view && !view.webContents.isDestroyed())
            view.setVisible(false);
        this.attachedWindow = null;
    }
    updatePrimaryViewBounds(bounds) {
        if (this.attachedWindow && this.view && !this.view.webContents.isDestroyed())
            this.view.setBounds(bounds);
    }
    getPrimaryWebContentsId() {
        return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.id : undefined;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.detachPrimaryView();
        await this.stop().catch(() => undefined);
        const view = this.view;
        this.view = null;
        this.viewLoad = undefined;
        if (view && !view.webContents.isDestroyed()) {
            this.client.detachEmbeddedWebContents(this.clientAccountId, view.webContents);
            view.webContents.close();
        }
    }
    ensureView() {
        if (this.view && !this.view.webContents.isDestroyed())
            return this.view;
        const host = this.context.getHostWindow();
        if (!host || host.isDestroyed())
            throw new Error('主工作台窗口尚未就绪');
        const config = this.client.getEmbeddedWebviewConfig(this.clientAccountId);
        const view = new WebContentsView({
            webPreferences: {
                partition: config.partition,
                preload: fileURLToPath(config.preload),
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
                sandbox: false,
                backgroundThrottling: false,
            },
        });
        view.setVisible(false);
        view.webContents.setWindowOpenHandler(({ url }) => {
            if (isOfficialLoginUrl(url))
                void view.webContents.loadURL(url).catch((error) => this.emitRuntimeError(error));
            return { action: 'deny' };
        });
        view.webContents.on('render-process-gone', (_event, details) => this.emitRuntimeError(new Error(`闲鱼页面进程退出: ${details.reason}`)));
        view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
            if (isMainFrame && code !== -3)
                this.emitRuntimeError(new Error(`闲鱼页面加载失败: ${description} (${url})`));
        });
        view.webContents.once('destroyed', () => {
            if (this.view === view) {
                this.view = null;
                this.viewLoad = undefined;
                this.attachedWindow = null;
            }
            this.client.detachEmbeddedWebContents(this.clientAccountId, view.webContents);
        });
        this.view = view;
        const load = (async () => {
            await this.client.attachEmbeddedWebContents(this.clientAccountId, view.webContents);
            await view.webContents.loadURL(config.url);
        })();
        this.viewLoad = load;
        void load.catch((error) => this.emitRuntimeError(error));
        return view;
    }
    async waitForPrimary(view) {
        if (view.webContents.isDestroyed())
            throw new Error('闲鱼官方页面已关闭');
        if (this.viewLoad)
            await this.viewLoad;
        if (view.webContents.isDestroyed())
            throw new Error('闲鱼官方页面已关闭');
    }
    onClientEvent(event) {
        const payload = asRecord(event.payload);
        if (event.eventType === 'account-migrated') {
            const previous = stringValue(payload.previousAccountId);
            const next = stringValue(payload.accountId ?? event.accountId);
            if (previous !== this.clientAccountId && event.accountId !== this.clientAccountId)
                return;
            if (next) {
                this.clientAccountId = next;
                const migrated = asRecord(payload.account);
                try {
                    const config = this.client.getEmbeddedWebviewConfig(next);
                    this.context.updateAccount({
                        partition: config.partition,
                        url: config.url,
                        adapterMetadata: { ...(this.account.adapterMetadata || {}), clientAccountId: next },
                        authenticated: migrated.status === 'authenticated',
                        ...(migrated.nickname ? { label: String(migrated.nickname) } : {}),
                    });
                }
                catch {
                    this.context.updateAccount({ adapterMetadata: { ...(this.account.adapterMetadata || {}), clientAccountId: next }, authenticated: migrated.status === 'authenticated' });
                }
            }
            return;
        }
        if (event.accountId !== this.clientAccountId)
            return;
        if (event.eventType === 'official-login-page')
            this.context.updateAccount({ authenticated: false });
        if (event.eventType === 'bridge-ready' || event.eventType === 'account-updated') {
            const status = asRecord(payload);
            this.context.updateAccount({
                authenticated: event.eventType === 'bridge-ready' || status.status === 'authenticated',
                ...(status.nickname && !this.account.label ? { label: String(status.nickname) } : {}),
            });
        }
        if (event.eventType === 'connection-error' || event.eventType === 'connection-closed' || event.eventType === 'load-error') {
            this.context.updateAccount({ connected: false });
        }
    }
    emitRuntimeError(value) {
        const message = value instanceof Error ? value.message : String(value);
        const event = { type: 'runtime.error', payload: { message }, timestamp: Date.now() };
        this.transport.emit(event);
    }
}
class GoofishAdapterTransport {
    inner;
    listeners = new Set();
    unsubscribe;
    constructor(inner) {
        this.inner = inner;
        this.unsubscribe = inner.subscribe((event) => this.emit(event));
    }
    start() { return this.inner.start(); }
    invoke(operation, input) {
        return this.inner.invoke(operation, input);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async stop() {
        this.unsubscribe();
        this.listeners.clear();
        await this.inner.stop();
    }
    emit(event) {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            }
            catch { /* isolate runtime observers */ }
        }
    }
}
export function createGoofishRuntimeFactory(userDataPath) {
    return new GoofishRuntimeFactory(userDataPath);
}
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function stringValue(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''; }
function temporaryAccountId() { return `${Date.now()}${Math.floor(Math.random() * 900_000 + 100_000)}`; }
function isOfficialLoginUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && ['goofish.com', 'taobao.com', 'alipay.com'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=goofish-runtime-adapter.js.map