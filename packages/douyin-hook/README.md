# @platform-hub/douyin-hook

Unified Hook Protocol implementation for the Douyin merchant workbench.

## Pages

- `primary`: `https://im.jinritemai.com/pc_seller_v2/main/workspace`
- `products`: `https://fxg.jinritemai.com/ffa/g/list?tab=all`
- `orders`: `https://fxg.jinritemai.com/ffa/arrival-pages/home`

The primary page owns authentication, sessions, messages, native conversation attention, and handoff. The products page is an on-demand worker. The orders page is a lazy-created persistent auxiliary page: the first `orders.list` or `orders.listen` call creates it, and it remains alive until the owning `HookSession` is disposed. It is not a persistent worker and is never idle-recycled. `conversation.attention.set` applies `pending`, `opened`, or `resolved` to one platform-native conversation row without exposing selectors or CSS to callers; multiple conversations remain independent. `handoff.targets.list` exposes the official targets currently available to the logged-in customer-service account; the application selects a target and calls `handoff.transfer` when its business flow requires handoff.

## Runtime sources

- Sessions and history: `ss._frontStore.conversationsInfo` and `talkerMap`
- Realtime messages: official `_message$`, `_messageUpsert$`, and `_batchUpsert$` streams, with a bounded history polling fallback only when those streams are unavailable
- Text and image sending: native IM `sendText` / `sendImage` plus `customRequestUpload`
- Products: the current authenticated official `/product/tproduct/list` response from the Electron product WebContents. The request uses the canonical in-sale query (`tab=all`, `business_type=4`, `is_online=1`, `not_for_sale_search_type=1`, `from_mng=1`), reads every page until the server-reported total is complete, and filters each response using its current `tab/status` so rows such as `审核驳回` are not reported as on-sale. `GOODS_SWR_CACHE_V1` is never a formal result source; if present it is only a platform diagnostic/bootstrap artifact.
- Orders: `/api/order/searchlist` is always the authoritative current-state source. An official runtime event with an `orderId` uses an exact `search_words=<orderId>` query. Electron verification also confirmed that the page's existing Frontier runtime dispatches decoded frames with `service=20132` and `method=0` for new-order and payment activity, but those frames do not expose an order ID or a semantic state. They only mark the order domain dirty and debounce one recent-order reconciliation; they never directly emit an order lifecycle event. `getshopbroadcastv3` and `reach/list` are historical/audit sources only. A bounded five-minute reconciliation remains the refund, disconnect, and missed-push fallback.
- Handoff targets and transfer: `uiState.chatRooms.transferConv`

Data capabilities use the official Runtime and do not operate the DOM. The sole DOM projection is the platform-specific implementation of `conversation.attention.set`: it restores native row highlighting after list rerenders and releases its observer and injected style on runtime disposal. Challenge handling returns `CHALLENGE_REQUIRED` to `HookSession`, which shows the official page and performs the Foundation recovery flow.

For the normalized DTOs, result envelope, event payloads, and Electron shell compatibility mapping, see [Douyin Hook 数据契约](../../docs/douyin-hook-data-contract.md).

## Real account verification

Run from the repository root:

```text
pnpm verify:douyin
```

The Electron window uses a persistent Douyin partition. Complete login and any official verification in that window. The terminal prints redacted JSON summaries and keeps listening for message and order events.

Optional side-effect checks are enabled only with explicit environment variables:

```text
DOUYIN_VERIFY_SEND_TEXT=验证消息
DOUYIN_VERIFY_FILE=D:\path\image.png
DOUYIN_VERIFY_FILE_MIME=image/png
DOUYIN_VERIFY_HANDOFF_TARGET_ID=staff-id
DOUYIN_VERIFY_HANDOFF_TARGET_NAME=客服名
```

Type `snapshot`, `restart`, or `quit` in the terminal during verification. `restart` checks dispose and same-partition recovery.

The following require a real authorized account and are not claimed as automatically verified: platform send acknowledgement, image upload, order runtime availability and change events, handoff target semantics, manual-origin metadata, logout/login recovery, and official challenge recovery.
