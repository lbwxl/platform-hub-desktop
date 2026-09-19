# @idle-fish/goofish-messaging

可复用的 Electron 闲鱼（Goofish）消息和商品工具包。它把官方闲鱼 IM 页面、商品个人页放在独立的 session partition 中，通过页面内部服务完成会话读取、历史消息、实时事件、消息发送和在售商品读取；不读取或保存账号密码，不使用 DOM 点击或输入模拟。

完整对接说明见仓库的 [`docs/goofish-messaging-integration.md`](../../docs/goofish-messaging-integration.md)。

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const { GoofishMessagingClient, registerGoofishIpc } = require('@idle-fish/goofish-messaging');

const client = new GoofishMessagingClient({ userDataPath: app.getPath('userData') });
registerGoofishIpc(client, {
  ipcMain,
  sendEvent: (event) => mainWindow?.webContents.send('goofish:event', event),
});
```

渲染层 preload 使用 `require('@idle-fish/goofish-messaging/renderer')` 中的 `exposeGoofishRendererApi`，然后通过 `window.goofishMessaging` 调用。

商品同步示例：

```js
const products = await window.goofishMessaging.products.list(accountId, {
  // 未登录时保持官方商品窗口打开，等待用户完成登录
  waitForLogin: true,
  // 安全上限，默认 1000 页；实际会持续到闲鱼返回 hasMore=false
  maxPages: 1000,
});
```

返回值兼容 `aichatclient` 的 `SyncGoodsItem`，例如 `id` 为
`goofish;shopId;goodsId`，并包含 `goodsId`、`name`、`price`、`images`、`goodsUrl`、`shopId`、`platform`、`skuList`、`attributes` 等字段。商品列表接口由官方页面自身发起，工具包只通过 Electron CDP Network 事件读取响应；闲鱼页面未登录时会发出 `products-login-required` 事件并显示官方窗口，登录完成后自动重新加载并继续读取。
