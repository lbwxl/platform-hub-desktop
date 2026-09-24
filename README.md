# 多平台电商 Hook 工作台

独立的 Electron + Vue 3 + TypeScript 应用，使用 `electron-vite` 构建。内置抖店与快手小店，同时提供统一 Hook 包协议，可导入闲鱼或其他平台适配器。

正式抖店实现位于 `packages/douyin-hook`（包名 `@platform-hub/douyin-hook`），通过 `window.__PLATFORM_HOOK__` 提供统一 Page Hook Protocol。旧 Legacy 包不再作为新代码、测试或脚本的目标。

抖店各项能力的 DTO、事件、错误和 Electron 壳层兼容格式见：[Douyin Hook 数据契约](docs/douyin-hook-data-contract.md)。

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
pnpm add @platform-hub/douyin-hook
```

```ts
import { createDouyinPageRuntime, douyinHookManifest } from '@platform-hub/douyin-hook'

const runtime = createDouyinPageRuntime({
  description: { protocolVersion: 1, platform: 'douyin', pageId: 'primary', capabilities: [], operations: [] },
  evaluate: (expression) => evaluateInCdpPage(expression),
})
const result = await runtime.invoke('sessions.list', {})
```

本地项目直接使用 workspace 包 `@platform-hub/douyin-hook`。正式验证脚本统一位于 `scripts/*douyin*`，测试统一位于 `tests/*douyin*`。

快手包可使用 `@platform-hub/kuaishou-hook: file:../douyin-platform-hub/packages/kuaishou-hook`，支持相同的 `syncOrders` / `subscribeOrders` 调用；发布前执行 `pnpm --dir packages/kuaishou-hook pack:check`。

开发界面由 Vite 提供在 `http://localhost:5173/`，同时自动启动 Electron 主窗口和抖店官方页面。

## 用可控 Reply API 验收 Hook

Main Process 收到买家入站消息后，会把规范化的平台、店铺、会话和买家字段发送到 Reply API；返回内容只作为测试/业务决策，实际发消息、发图片、设置原生 attention 和官方客服转接仍由对应店铺的 Hook 执行。Reply API 默认地址为 `http://192.168.5.3:18021/api/v1/chats/reply`，Mock 控制台在 `http://192.168.5.3:18021/`。可用 `PLATFORM_HUB_REPLY_API_URL` 覆盖完整接口地址，用 `PLATFORM_HUB_REPLY_API_TIMEOUT_MS` 设置单次请求超时（默认 15 秒）。

先在 Mock 控制台选择响应场景，再让已登录且 online 的 FakeHook/测试店铺收到消息，就能验收单条/多条文本、静默、人工 attention、官方目标转接和图片发送。`ai_reply.file_urls` 当前只会尝试发送图片；PDF 等非图片会作为附件失败记录，不会伪装成功。地图卡片尚无 Hook 发送能力，会在运行事件中标记为 unsupported。找不到或不匹配官方客服目标时不会擅自转接，而是进入 pending attention。接口错误、超时或无效响应会显示为运行错误，不会自动编造一条对买家的降级话术。

更完整的场景、控制 API 和限制见 [`docs/reply-api-hook-testing.md`](docs/reply-api-hook-testing.md)。

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

## Douyin window runtime 约定

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
- 商品同步使用当前 Electron 商品 WebContents 的官方 `/product/tproduct/list` 请求，按明确的在售条件完整分页，并按本次响应的官方 `tab/status` 排除非在售行后作为权威结果；`GOODS_SWR_CACHE_V1` 仅保留为诊断/启动探索信息，不参与 `products.list`。

平台页面升级后若方法名称改变，只需更新抖店 Hook 的别名和数据归一化，不需要修改 Electron、IPC 或工作台 UI。
