# Reply API 驱动 Hook 验收

Reply API 是 Main Process 的可控决策输入，不属于平台 Hook。用户可在 Mock 控制台预装一次性、持续或队列场景；入站消息触发 API 后，返回的响应决定 Main Process 接下来调用哪个 Hook Operation。

```text
买家入站消息
  → ShopRuntimeManager
  → POST /api/v1/chats/reply
  → 解析 ai_reply / lifecycle / turn
  → 对应店铺 Hook Operation
  → 平台官方 WebContent
```

## 地址与控制

- Reply API：`http://192.168.5.3:18021/api/v1/chats/reply`
- Mock 控制台：`http://192.168.5.3:18021/`
- 控制接口：`http://192.168.5.3:18021/__mock`
- `PLATFORM_HUB_REPLY_API_URL`：覆盖完整 Reply API URL。
- `PLATFORM_HUB_REPLY_API_TIMEOUT_MS`：每次请求超时，默认 15000 ms。

Main Process 直接请求接口，不受浏览器 CORS 限制。不要用真人买家会话做接口联调；优先通过 FakeHook / 自动化测试触发消息和 Hook 操作。

Mock 控制 API 可设置 `next`、`persistent`、`queue` 或按 `platform_en` / `shop_id` / `customer_id` / `message` 匹配规则。下单验收时可先在控制台选择响应，再从 FakeHook 发一条入站消息。需要排查响应时，可以在 Mock 控制台查询其 `/__mock/requests` 请求历史。

## 响应到 Hook 的映射

| Reply API 响应 | Main Process 行为 |
| --- | --- |
| `ai_reply.reply_parts` | 按原顺序逐条调用 `messages.send.text`，不合并消息 |
| `ai_reply == null` | 静默，不发送消息 |
| `ai_reply.file_urls` | 先发文本，再读取附件并调用 `messages.send.file` |
| `transfer.is_transfer` | 先发回复和 `transfer_messages`；仅目标匹配 `handoff.targets.list` 官方列表时调用 `handoff.transfer` |
| 缺少/不匹配官方转接目标 | 不猜测目标；调用 `conversation.attention.set(pending)` |
| `lifecycle.action` greeting/farewell | 通过 `messages.send.text` 发送非空 `action.messages` |
| `lifecycle.action` 地图卡片 | 目前没有统一地图卡片 Hook Operation；保留事件并标记 `unsupportedLifecycleAction`，不伪装成已发送 |
| `turn` | 保留在运行事件中；`should_process: false` 时跳过外发 |

店铺处于 offline 或在 API 等待期间切为 offline 后，不会继续发送文本、附件或转接。自动回复只处理 `direction=inbound` 且 `origin=customer` 的消息；自动发送回声不会再次请求 Reply API。

## 错误与附件限制

- HTTP 400、401、403、404 不重试；429、500、502、503 最多总计 3 次，并遵守不超过 30 秒的 `Retry-After`。网络错误/超时也最多尝试 3 次。
- 超时、断线、空 body、非法 JSON 和 HTTP 错误会作为带错误码的 Main 运行事件呈现，不会把错误 body 当成回复，也不会自动编造兜底话术。
- `reply_parts`、`file_urls`、`transfer_messages` 在运行时校验；字段类型错误会变为 warning/静默，不会导致遍历异常。
- 附件 URL 必须为公网 HTTPS；当前 Douyin Hook 只支持图片 MIME，单个附件上限 8 MB。Mock 示例中的 PDF 会失败并记录 `fileErrors`，不会声称发送成功。
- Mock 控制场景是对 Reply API 的响应控制，不会自动登录店铺，也不代表真人平台验收。

## 自动验证

执行 `pnpm test` 会运行 `tests/shop-reply-api.test.mjs` 和 `tests/shop-runtime-manager.test.mjs`。前者用可注入 fetcher 覆盖请求格式、解析、重试和协议异常；后者通过 FakeHook 验证消息发送、附件 Operation、人工 attention、官方目标转接、多店铺隔离及 Echo 不重入。自动测试不请求真实 Mock 服务，也不向真人会话发送消息。
