const { createIpcChannels } = require('./constants.cjs');

function registerGoofishIpc(client, options = {}) {
  if (!client) throw new TypeError('registerGoofishIpc 需要 client');
  const ipcMain = options.ipcMain || require('electron').ipcMain;
  if (!ipcMain) throw new TypeError('registerGoofishIpc 需要 ipcMain');
  const channels = createIpcChannels(options.channelPrefix || 'goofish');
  const eventChannel = options.eventChannel || channels.event;
  const sendEvent = options.sendEvent || (() => {});
  const authorize = options.authorize || (() => true);
  const handlers = new Map();
  const handle = (channel, fn) => {
    const wrapped = (event, ...args) => {
      if (!authorize(event)) throw new Error('闲鱼消息 IPC 调用未获授权');
      return fn(event, ...args);
    };
    handlers.set(channel, wrapped);
    ipcMain.handle(channel, wrapped);
  };
  handle(channels.accountsList, () => client.listAccounts());
  handle(channels.accountsAdd, (_event, input) => client.addAccount(input || {}));
  handle(channels.accountsMigrate, (_event, input = {}) => client.migrateAccount(input.accountId, input.nextAccountId));
  handle(channels.accountsRemove, (_event, accountId) => client.removeAccount(accountId));
  handle(channels.accountsOpen, (_event, input) => {
    const accountId = typeof input === 'string' ? input : input?.accountId;
    const show = typeof input === 'string' ? true : input?.show !== false;
    return client.openAccount(accountId, show);
  });
  handle(channels.accountsRefresh, (_event, accountId) => client.refreshAccount(accountId));
  handle(channels.accountsSnapshot, (_event, accountId) => client.snapshot(accountId));
  handle(channels.sessionsList, (_event, accountId) => client.listSessions(accountId));
  handle(channels.sessionsOpen, (_event, input = {}) => client.openSession(input.accountId, input.sessionId));
  handle(channels.messagesList, (_event, input = {}) => client.listMessages(input.accountId, input.sessionId, input.options));
  handle(channels.messagesLoadMore, (_event, input = {}) => client.loadMoreMessages(input.accountId, input.sessionId, input.fetchs));
  handle(channels.messagesSend, (_event, input = {}) => client.sendMessage(input.accountId, input.sessionId, input.message || input));
  handle(channels.productsList, (_event, input = {}) => client.listOnSaleProducts(input.accountId, input.options || input));
  handle(channels.productsOpen, (_event, input = {}) => client.openProducts(input.accountId, input.url));
  handle(channels.productsClose, (_event, accountId) => client.closeProducts(accountId));

  const pageMessageListener = (event, data) => client.handlePageMessage(event.sender, data);
  ipcMain.on('goofish:event', pageMessageListener);
  const clientListener = (event) => sendEvent(event);
  client.on('event', clientListener);

  return {
    channels: { ...channels, event: eventChannel },
    dispose() {
      for (const channel of handlers.keys()) ipcMain.removeHandler?.(channel);
      ipcMain.removeListener?.('goofish:event', pageMessageListener);
      client.off('event', clientListener);
    },
  };
}

module.exports = { registerGoofishIpc };
