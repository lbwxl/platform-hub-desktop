const { GoofishMessagingClient } = require('./client.cjs');
const { GoofishAccount } = require('./goofish-account.cjs');
const { JsonAccountRepository } = require('./account-repository.cjs');
const { NdjsonLogger } = require('./ndjson-logger.cjs');
const { registerGoofishIpc } = require('./ipc-adapter.cjs');
const { GoofishProductCatalog, normalizeProductCard, normalizeProductDetail, PRODUCT_LIST_API, PRODUCT_DETAIL_API } = require('./product-catalog.cjs');
const { createIpcChannels, GOOFISH_URL } = require('./constants.cjs');

module.exports = {
  GoofishAccount,
  GoofishProductCatalog,
  GoofishMessagingClient,
  JsonAccountRepository,
  NdjsonLogger,
  GOOFISH_URL,
  createIpcChannels,
  registerGoofishIpc,
  normalizeProductCard,
  normalizeProductDetail,
  PRODUCT_LIST_API,
  PRODUCT_DETAIL_API,
};
