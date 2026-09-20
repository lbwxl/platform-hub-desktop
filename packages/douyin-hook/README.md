# @platform-hub/douyin-hook

Unified Hook Protocol implementation for the Douyin merchant workbench.

## Pages

- `primary`: `https://im.jinritemai.com/pc_seller_v2/main/workspace`
- `products`: `https://fxg.jinritemai.com/ffa/g/list?tab=all`

The primary page owns authentication, sessions, messages, orders, and handoff. The products page is an on-demand worker. `handoff.targets.list` is intentionally not declared because the current official runtime evidence does not provide a reliable, stable target enumeration contract.

## Runtime sources

- Sessions and history: `ss._frontStore.conversationsInfo` and `talkerMap`
- Realtime messages: official `_message$`, `_messageUpsert$`, and `_batchUpsert$` streams, with a bounded history polling fallback only when those streams are unavailable
- Text and image sending: native IM `sendText` / `sendImage` plus `customRequestUpload`
- Products: the official product page's loaded `GOODS_SWR_CACHE_V1` state
- Orders: official order store methods when present, combined with normalized order cards from session history
- Handoff: `uiState.chatRooms.transferConv`

The implementation does not read or operate DOM elements. Challenge handling returns `CHALLENGE_REQUIRED` to `HookSession`, which shows the official page and performs the Foundation recovery flow.

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
