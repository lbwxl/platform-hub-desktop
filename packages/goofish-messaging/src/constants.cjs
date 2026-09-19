const path = require('node:path');

const GOOFISH_URL = 'https://www.goofish.com/im';
const GOOFISH_PERSONAL_URL = 'https://www.goofish.com/personal';
const OFFICIAL_LOGIN_HOSTS = Object.freeze(['goofish.com', 'taobao.com', 'alipay.com']);
const ALLOWED_COMMANDS = Object.freeze([
  'sessions:list',
  'messages:list',
  'messages:send',
  'messages:load-more',
  'snapshot',
]);
const ASSET_DIR = path.resolve(__dirname, '..', 'assets');

function normalizeChannelPrefix(value = 'goofish') {
  const prefix = String(value || 'goofish');
  return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

function createIpcChannels(prefix) {
  const normalized = normalizeChannelPrefix(prefix);
  return Object.freeze({
    accountsList: `${normalized}accounts:list`,
    accountsAdd: `${normalized}accounts:add`,
    accountsMigrate: `${normalized}accounts:migrate`,
    accountsRemove: `${normalized}accounts:remove`,
    accountsOpen: `${normalized}accounts:open`,
    accountsRefresh: `${normalized}accounts:refresh`,
    accountsSnapshot: `${normalized}accounts:snapshot`,
    sessionsList: `${normalized}sessions:list`,
    sessionsOpen: `${normalized}sessions:open`,
    messagesList: `${normalized}messages:list`,
    messagesLoadMore: `${normalized}messages:load-more`,
    messagesSend: `${normalized}messages:send`,
    productsList: `${normalized}products:list`,
    productsOpen: `${normalized}products:open`,
    productsClose: `${normalized}products:close`,
    event: `${normalized}event`,
  });
}

module.exports = {
  ALLOWED_COMMANDS,
  ASSET_DIR,
  GOOFISH_URL,
  GOOFISH_PERSONAL_URL,
  OFFICIAL_LOGIN_HOSTS,
  createIpcChannels,
  normalizeChannelPrefix,
};
