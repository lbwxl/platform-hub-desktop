# @platform-hub/douyin-hook

Unified Hook Protocol implementation for the Douyin merchant workbench.

## Pages

- `primary`: `https://im.jinritemai.com/pc_seller_v2/main/workspace`
- `products`: `https://fxg.jinritemai.com/ffa/g/list?tab=all`
- `orders`: `https://fxg.jinritemai.com/ffa/arrival-pages/home`

The primary page owns authentication, sessions, messages, and handoff. The products page is an on-demand worker. The orders page is a lazy-created persistent auxiliary page: the first `orders.list` or `orders.listen` call creates it, and it remains alive until the owning `HookSession` is disposed. It is not a persistent worker and is never idle-recycled. `handoff.targets.list` exposes the official targets currently available to the logged-in customer-service account; the application selects a target and calls `handoff.transfer` when its business flow requires handoff.

## Runtime sources

- Sessions and history: `ss._frontStore.conversationsInfo` and `talkerMap`
- Realtime messages: official `_message$`, `_messageUpsert$`, and `_batchUpsert$` streams, with a bounded history polling fallback only when those streams are unavailable
- Text and image sending: native IM `sendText` / `sendImage` plus `customRequestUpload`
- Products: the official product page's loaded `GOODS_SWR_CACHE_V1` state
- Orders: the lazy persistent commerce page subscribes to the official notification runtime, extracts `msgItem.ext_info` order identifiers, and queries the same-origin official `/api/order/searchlist?...&search_words=<orderId>` endpoint as the authoritative snapshot. A bounded five-minute reconciliation is only a disconnect fallback; the primary page only resolves conversation-scoped order context when needed.
- Handoff targets and transfer: `uiState.chatRooms.transferConv`

The implementation does not read or operate DOM elements. Challenge handling returns `CHALLENGE_REQUIRED` to `HookSession`, which shows the official page and performs the Foundation recovery flow.

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
