function createGoofishRendererApi({ ipcRenderer, channelPrefix = 'goofish', eventChannel } = {}) {
  if (!ipcRenderer) throw new TypeError('createGoofishRendererApi 需要 ipcRenderer');
  const prefix = String(channelPrefix || 'goofish').replace(/:+$/, '');
  const channel = (name) => `${prefix}:${name}`;
  const eventName = eventChannel || channel('event');
  return Object.freeze({
    accounts: {
      list: () => ipcRenderer.invoke(channel('accounts:list')),
      add: (label, options = {}) => ipcRenderer.invoke(channel('accounts:add'), { ...options, label }),
      migrate: (accountId, nextAccountId) => ipcRenderer.invoke(channel('accounts:migrate'), { accountId, nextAccountId }),
      remove: (accountId) => ipcRenderer.invoke(channel('accounts:remove'), accountId),
      open: (accountId, show = true) => ipcRenderer.invoke(channel('accounts:open'), { accountId, show }),
      refresh: (accountId) => ipcRenderer.invoke(channel('accounts:refresh'), accountId),
      snapshot: (accountId) => ipcRenderer.invoke(channel('accounts:snapshot'), accountId),
    },
    sessions: {
      list: (accountId) => ipcRenderer.invoke(channel('sessions:list'), accountId),
      open: (accountId, sessionId) => ipcRenderer.invoke(channel('sessions:open'), { accountId, sessionId }),
    },
    messages: {
      list: (accountId, sessionId, options) => ipcRenderer.invoke(channel('messages:list'), { accountId, sessionId, options }),
      loadMore: (accountId, sessionId, fetchs) => ipcRenderer.invoke(channel('messages:load-more'), { accountId, sessionId, fetchs }),
      send: (accountId, sessionId, message) => ipcRenderer.invoke(channel('messages:send'), { accountId, sessionId, message: typeof message === 'string' ? { type: 'text', content: message } : message }),
    },
    products: {
      list: (accountId, options = {}) => ipcRenderer.invoke(channel('products:list'), { accountId, options }),
      open: (accountId, url) => ipcRenderer.invoke(channel('products:open'), { accountId, url }),
      close: (accountId) => ipcRenderer.invoke(channel('products:close'), accountId),
    },
    onEvent(callback) {
      if (typeof callback !== 'function') throw new TypeError('onEvent 需要回调函数');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(eventName, listener);
      return () => ipcRenderer.removeListener(eventName, listener);
    },
  });
}

function exposeGoofishRendererApi({ contextBridge, ipcRenderer, globalName = 'goofishMessaging', ...options } = {}) {
  if (!contextBridge) throw new TypeError('exposeGoofishRendererApi 需要 contextBridge');
  const api = createGoofishRendererApi({ ipcRenderer, ...options });
  contextBridge.exposeInMainWorld(globalName, api);
  return api;
}

module.exports = { createGoofishRendererApi, exposeGoofishRendererApi };
