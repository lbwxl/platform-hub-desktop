# Phase 0 旧 Hook 分层分析

旧实现已保存为 Git Tag `legacy-hook-phase0`（commit `fadea35`）。本文只记录可参考的事实，不把旧架构带入新协议。

## 平台能力

- Legacy Reference（历史上的旧抖店包）与 `packages/legacy-kuaishou-hook` 中的 window runtime 探测、平台方法适配、字段解析和 DTO normalize。
- 平台登录状态、会话与历史消息读取、消息发送、商品和订单 API 调用。
- 平台原始状态到商品/订单/消息公共语义的映射。
- 平台官方事件或平台 SDK 事件的订阅方式。

这些能力应迁入未来各自的 Specific Platform Hook，只通过 `window.__PLATFORM_HOOK__` 暴露统一 `describe/invoke/drainEvents/dispose`。

## Electron Host 能力

- `src/main/cdp/CdpSession.ts` 中 BrowserWindow/WebContents/CDP 生命周期、Partition、页面打开与关闭。
- Primary Page 与商品/订单辅助页面的创建、复用和空闲回收。
- Hook 安装、页面导航后重装、Runtime 调用、事件抽取。
- 超时、Abort、并发、任务优先级、Challenge 页面展示和恢复。
- `src/main/cdp/PlatformManager.ts` 中多店铺 Session 生命周期与持久化边界。

这些能力由 `packages/core-page-host` 统一管理。平台 Hook 不创建 Electron 页面，也不管理轮询计时器。

## 旧架构中的混合职责

- 旧平台 Hook 内部自行 `setInterval` 轮询订单，混合了平台数据读取与 Host 调度。
- `CdpSession` 通过任意方法名和 JavaScript expression 调用 runtime，并使用 `runtimePages.methods` 路由。
- 旧 DTO/Result 同时出现 `success`、`ok`、`value`、`errorCode` 等返回风格。
- Host 内事件类型映射与平台方法名存在耦合。

Phase 0 用 Manifest operation 路由、`HookResult`、统一 DTO/Event 和 Host Scheduler 替代这些混合点。
