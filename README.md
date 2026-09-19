# 多平台电商 Hook 工作台

独立的 Electron + Vue 3 + TypeScript 应用，使用 `electron-vite` 构建。内置抖店与快手小店，同时提供统一 Hook 包协议，可导入闲鱼或其他平台适配器。

抖店能力已经独立为纯前端可复用包：`packages/doudian-hook`（包名 `@platform-hub/doudian-hook`）。其他系统安装该包后，只需把自己的 `webContents.debugger.sendCommand('Runtime.evaluate', ...)` 封装成一个 `evaluate` 函数，即可接入登录、会话、消息、回复、图片、商品和订单监听；订单不会写入本项目的后端，接入方通过 `subscribeOrders` 自己写入目标系统。接口文档见 `packages/doudian-hook/API.md`。

快手小店能力位于 `packages/kuaishou-hook`（包名 `@platform-hub/kuaishou-hook`），使用相同的 typed client、订单同步和订单事件协议，默认消息页为 `https://im.kwaixiaodian.com/workbench`。

## 当前能力

- 每个账号使用独立的 Electron persistent session，登录只在平台官方页面完成。
- 抖店与快手小店 Hook 都只通过 CDP 调用 `window` 暴露的运行时对象，不读取、查询或操作 DOM。
- 未登录或 runtime 尚未就绪时返回 `LOGIN_REQUIRED` / `RUNTIME_NOT_READY`，主进程保持页面打开并等待用户登录，登录后自动重试原操作。
- 已接通会话列表、消息历史、实时消息监听、文本回复、图片发送、商品列表和商品详情采集。
- 商品能力运行在共享同一登录 partition 的官方商品管理伴随页；采集读取页面公开的 `window` 状态，不拦截请求。
- 订单读取和订单监听、会话转接保留统一调用协议。Hook 只返回归一化订单事件，不持久化订单；当前页面未暴露对应方法或没有可转接目标时会返回明确错误，不会伪造成功结果。
- window runtime 使用能力别名发现，不把平台内部对象名称耦合到 UI 和 IPC。
- Hook 包通过 `manifest.json + entry.js` 导入；示例见 `packages/goofish-hook`。

## 开发运行

```powershell
pnpm install
pnpm dev
```

## 作为 package 接入

```bash
pnpm add @platform-hub/doudian-hook
```

```ts
import { createDoudianClient, doudianHook } from '@platform-hub/doudian-hook'

const client = createDoudianClient((expression) => evaluateInCdpPage(expression))
await client.install()
await client.waitForLogin()
const stop = client.subscribe((event) => console.log(event.type, event.payload))
const sessions = await client.listSessions()
await client.sendMessage(sessions[0].id, '你好')
```

本地项目可使用 `@platform-hub/doudian-hook: file:../doudian-platform-hub/packages/doudian-hook`。发布前执行 `pnpm --dir packages/doudian-hook pack:check`，会在 `artifacts/` 生成可直接安装的 `.tgz`。

快手包可使用 `@platform-hub/kuaishou-hook: file:../doudian-platform-hub/packages/kuaishou-hook`，支持相同的 `syncOrders` / `subscribeOrders` 调用；发布前执行 `pnpm --dir packages/kuaishou-hook pack:check`。

开发界面由 Vite 提供在 `http://localhost:5173/`，同时自动启动 Electron 主窗口和抖店官方页面。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
```

## Hook 包协议

`manifest.json` 声明平台标识、官方入口、能力和脚本入口：

```json
{
  "id": "example",
  "label": "示例平台",
  "version": "1.0.0",
  "url": "https://example.com/",
  "capabilities": ["messages.listen", "messages.history", "messages.send", "products.collect"],
  "entry": "hook.js"
}
```

`entry` 必须位于 manifest 同目录或子目录。脚本在平台页面主世界中注册 `window.__platformHub`，实现所声明的方法。渲染层只依赖统一 IPC，不依赖平台脚本细节。Hook 版本变化时旧订阅会先被释放，避免重新注入产生重复监听。

## 抖店 window runtime 约定

适配器会在 `window` 上扫描名称与电商、IM、SDK 相关的公开对象，并按方法能力绑定。支持的主要别名包括：

- 登录：`getAuthState`、`getLoginState`、`getShopInfo`
- 商品：`collectProducts`、`listProducts`、`getProductList`、`getProductDetail`
- 会话与历史：`listSessions`、`getConversationList`、`listMessages`、`getMessages`
- 消息：`subscribeMessages`、`onMessage`、`sendMessage`、`sendText`
- 订单与转接：`getOrders`、`queryOrders`、`transferSession`、`transferConversation`

抖店当前实测路径会直接使用飞鸽页面的消息流与发送服务：

- `_message$`、`_messageUpsert$`、`_batchUpsert$` 负责消息监听，并按消息 ID 与内容指纹去重。
- `im.sendText` 发送文本。
- `customRequestUpload` 上传图片，随后由 `im.sendImage` 发送；其他文件类型返回 `UNSUPPORTED_FILE_TYPE`。
- `GOODS_SWR_CACHE_V1` 提供官方商品页公开在 `window.localStorage` 中的商品状态。

平台页面升级后若方法名称改变，只需更新抖店 Hook 的别名和数据归一化，不需要修改 Electron、IPC 或工作台 UI。
