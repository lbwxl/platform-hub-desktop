import { app, dialog, WebContentsView, BrowserWindow, shell, ipcMain } from "electron";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { PlatformRuntimeManager, PlatformRegistry, createPageRuntimeFactory } from "@platform-hub/platform-runtime";
import { EventEmitter } from "node:events";
import { createDouyinRuntimeFactory, douyinHook } from "@platform-hub/douyin";
import { createGoofishRuntimeFactory } from "@platform-hub/goofish";
import { kuaishouHook } from "@platform-hub/kuaishou-hook";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const MESSAGE_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const MAX_MESSAGE_CLAIMS = 1e5;
const AUTOMATION_OUTBOUND_TTL_MS = 3e4;
const MAX_AUTOMATION_OUTBOUNDS = 500;
class ShopRuntimeManager {
  runtimes = /* @__PURE__ */ new Map();
  /**
   * Message delivery is shared by all account runtimes for the same shop.
   * Douyin can replay a conversation's existing messages after handoff; the
   * per-page/per-account listener watermarks cannot dedupe those deliveries.
   */
  messageClaims = /* @__PURE__ */ new Map();
  automationOutbounds = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  replyApi;
  fileLoader;
  constructor(replyApi, options = {}) {
    this.replyApi = replyApi;
    this.fileLoader = options.fileLoader || loadReplyFile;
  }
  register(accountId, transport, context = {}) {
    if (this.runtimes.has(accountId)) return;
    const runtime = {
      accountId,
      platform: context.platform || "unknown",
      shopName: context.shopName || accountId,
      // Use the account id as a stable mock-routing fallback until auth.state
      // supplies the platform's real shop id.
      shopId: accountId,
      transport,
      online: false,
      runtimeState: "stopped",
      messageListening: false,
      attention: /* @__PURE__ */ new Map(),
      processing: /* @__PURE__ */ new Set()
    };
    runtime.unsubscribe = transport.subscribe((event) => this.handleEvent(runtime, event));
    this.runtimes.set(accountId, runtime);
  }
  unregister(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.unsubscribe?.();
    runtime.unsubscribe = void 0;
    this.runtimes.delete(accountId);
    this.automationOutbounds.delete(accountId);
  }
  has(accountId) {
    return this.runtimes.has(accountId);
  }
  snapshot(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return void 0;
    return this.toSnapshot(runtime);
  }
  snapshots() {
    return [...this.runtimes.values()].map((runtime) => this.toSnapshot(runtime));
  }
  async setOnline(accountId, online) {
    const runtime = this.require(accountId);
    runtime.online = online;
    if (!online) {
      this.emit(runtime, "runtime", { online: false, runtimeState: runtime.runtimeState, messageListening: runtime.messageListening });
      return this.toSnapshot(runtime);
    }
    await this.start(runtime);
    return this.toSnapshot(runtime);
  }
  async stop(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.online = false;
    runtime.messageListening = false;
    runtime.runtimeState = "stopped";
    await runtime.transport.stop();
    runtime.unsubscribe?.();
    runtime.unsubscribe = void 0;
    this.runtimes.delete(accountId);
    this.automationOutbounds.delete(accountId);
  }
  async setAttention(accountId, conversationId, state) {
    const runtime = this.require(accountId);
    const result = await runtime.transport.invoke("conversation.attention.set", { conversationId, state });
    if (!result.ok) {
      if (result.error.code === "NOT_SUPPORTED") {
        this.emit(runtime, "attention", { conversationId, requestedState: state, supported: false });
        return;
      }
      throw new Error(result.error.message);
    }
    runtime.attention.set(conversationId, state);
    this.emit(runtime, "attention", { conversationId, state });
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Feed a native/legacy event into the same account-scoped pipeline. */
  pushEvent(accountId, event) {
    const runtime = this.runtimes.get(accountId);
    if (runtime) this.handleEvent(runtime, event);
  }
  /**
   * The Electron compatibility shell can receive an official outbound echo
   * without the Page Hook origin metadata. Attribute only messages that were
   * sent through this account's Reply API path, using a short-lived record and
   * an exact platform message id whenever one is available.
   */
  annotateEvent(accountId, event) {
    if (event.type !== "message") return event;
    const payload = asRecord$1(event.payload);
    const message = asRecord$1(payload.message || event.payload);
    const raw = asRecord$1(message.raw);
    const attribution = asRecord$1(raw.attributionMetadata);
    if (message.direction !== "outbound" || message.origin === "human" || message.origin === "automation" || attribution.manualSendCheck === true) return event;
    const records = this.automationOutbounds.get(accountId);
    if (!records?.length) return event;
    const now = Date.now();
    while (records.length && now - records[0].createdAt > AUTOMATION_OUTBOUND_TTL_MS) records.shift();
    const id = scalarString(message.id ?? message.serverId ?? message.messageId);
    const conversationId = scalarString(message.conversationId ?? message.sessionId);
    const type = scalarString(message.type ?? message.messageType) || "text";
    const content = scalarString(message.content ?? message.text);
    const matched = records.find((record) => Boolean(record.id && id && record.id === id)) || records.find((record) => {
      const timestamp = Number(message.timestamp) || event.timestamp || now;
      return record.conversationId === conversationId && record.type === type && record.content === content && timestamp >= record.createdAt - 5e3 && timestamp <= record.createdAt + AUTOMATION_OUTBOUND_TTL_MS;
    });
    if (!matched) return event;
    const index = records.indexOf(matched);
    if (index >= 0) records.splice(index, 1);
    const annotatedMessage = { ...message, origin: "automation" };
    return {
      ...event,
      payload: Object.prototype.hasOwnProperty.call(payload, "message") ? { ...payload, message: annotatedMessage } : annotatedMessage
    };
  }
  async start(runtime) {
    if (runtime.runtimeState === "running") return;
    if (runtime.startPromise) return runtime.startPromise;
    runtime.runtimeState = "starting";
    runtime.startPromise = (async () => {
      try {
        await runtime.transport.start();
        const auth = await runtime.transport.invoke("auth.state", {});
        if (!auth.ok) throw new Error(auth.error.message);
        const authData = asRecord$1(auth.data);
        const shopId = scalarString(authData.shopId ?? authData.shop_id);
        const userId = scalarString(authData.userId ?? authData.user_id);
        const authFlag = [authData.authenticated, authData.isLogin, authData.loggedIn].find((value) => typeof value === "boolean");
        const authenticated = typeof authFlag === "boolean" ? authFlag : Boolean(shopId || userId);
        if (!authenticated) throw new Error("LOGIN_REQUIRED: 店铺尚未登录，暂不启动 Reply API 自动处理");
        if (shopId) runtime.shopId = shopId;
        const listening = await runtime.transport.invoke("messages.listen", {});
        if (!listening.ok) throw new Error(listening.error.message);
        runtime.messageListening = true;
        runtime.runtimeState = "running";
        this.emit(runtime, "runtime", { online: runtime.online, runtimeState: runtime.runtimeState, messageListening: true });
      } catch (error) {
        runtime.runtimeState = "error";
        this.emit(runtime, "runtime", { online: runtime.online, runtimeState: "error", message: errorMessage(error) });
        throw error;
      } finally {
        runtime.startPromise = void 0;
      }
    })();
    return runtime.startPromise;
  }
  handleEvent(runtime, event) {
    const timestamp = event.timestamp || Date.now();
    this.emit(runtime, "hook", { event });
    if (event.type !== "message.created") return;
    const message = event.payload.message;
    if (!message) return;
    const conversationId = String(message.conversationId || message.sessionId || "");
    if (!conversationId) return;
    const direction = message.direction;
    const origin = message.origin;
    if (direction === "outbound") {
      if (origin === "human") void this.setAttention(runtime.accountId, conversationId, "resolved").catch(() => void 0);
      return;
    }
    if (direction !== "inbound" || origin !== "customer" || message.type === "system" || message.type === "order") return;
    runtime.lastIncomingAt = timestamp;
    const key = String(message.id || `${conversationId}:${timestamp}`);
    if (!runtime.online || runtime.runtimeState !== "running" || !runtime.messageListening || runtime.processing.has(key)) return;
    if (!this.claimShopMessage(runtime, conversationId, message)) return;
    runtime.processing.add(key);
    void this.processCustomerMessage(runtime, conversationId, message).finally(() => runtime.processing.delete(key));
  }
  claimShopMessage(runtime, conversationId, message) {
    const messageId = scalarString(message.id);
    if (!messageId) return true;
    const now = Date.now();
    for (const [key, expiresAt] of this.messageClaims) {
      if (expiresAt > now) break;
      this.messageClaims.delete(key);
    }
    const claimKey = JSON.stringify([runtime.platform, runtime.shopId, conversationId, messageId]);
    if (this.messageClaims.has(claimKey)) {
      this.messageClaims.delete(claimKey);
      this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS);
      return false;
    }
    this.messageClaims.set(claimKey, now + MESSAGE_CLAIM_TTL_MS);
    while (this.messageClaims.size > MAX_MESSAGE_CLAIMS) {
      const oldest = this.messageClaims.keys().next().value;
      if (oldest === void 0) break;
      this.messageClaims.delete(oldest);
    }
    return true;
  }
  async processCustomerMessage(runtime, conversationId, message) {
    try {
      const decision = await this.replyApi.reply({
        accountId: runtime.accountId,
        platform: runtime.platform,
        shopId: runtime.shopId,
        shopName: runtime.shopName,
        conversationId,
        content: String(message.content || ""),
        customerId: String(message.senderId || message.userId || ""),
        customerName: String(message.senderName || message.name || ""),
        message
      });
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) {
        this.emit(runtime, "reply", { decision, conversationId, deliverySkipped: "shop-offline" });
        return;
      }
      if (decision.type === "reply") {
        const effects = {};
        if (decision.warnings?.length) effects.warnings = decision.warnings;
        if (decision.turn) effects.turn = decision.turn;
        if (decision.lifecycleAction) {
          const action = decision.lifecycleAction;
          const mapCard = action.payload?.map_card;
          if (action.kind === "map-card" || action.actionCode === 2 || mapCard) {
            effects.unsupportedLifecycleAction = "map-card";
            if (action.messages.length) await this.sendTexts(runtime, conversationId, action.messages);
          } else if (action.kind === "greeting" || action.kind === "farewell") {
            await this.sendTexts(runtime, conversationId, action.messages);
          }
          effects.lifecycleAction = action;
        } else {
          const texts = decision.texts || (decision.text ? [decision.text] : []);
          await this.sendTexts(runtime, conversationId, texts);
          for (const fileUrl of decision.fileUrls || []) {
            try {
              if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) break;
              const file = await this.fileLoader(fileUrl);
              const correlation = this.trackAutomation(runtime.accountId, conversationId, "image", file.name);
              try {
                const result = await runtime.transport.invoke("messages.send.file", {
                  conversationId,
                  data: file.dataUrl,
                  dataUrl: file.dataUrl,
                  name: file.name,
                  mimeType: file.mimeType
                });
                if (!result.ok) throw new Error(result.error.message);
                this.completeAutomation(correlation, result.data);
              } catch (error) {
                this.removeAutomation(runtime.accountId, correlation);
                throw error;
              }
            } catch (error) {
              const failures = Array.isArray(effects.fileErrors) ? effects.fileErrors : [];
              failures.push(errorMessage(error));
              effects.fileErrors = failures;
            }
          }
          if (decision.transfer) {
            await this.sendTexts(runtime, conversationId, decision.transfer.messages);
            if (decision.transfer.sendGreetingBeforeHandoff && decision.transfer.messages.length === 0) {
              await this.sendTexts(runtime, conversationId, ["您好，为您转接人工客服"]);
            }
            effects.handoff = await this.transferToOfficialTarget(runtime, conversationId, decision.transfer);
          }
        }
        this.emit(runtime, "reply", { decision, conversationId, ...effects });
      } else if (decision.type === "human_required") {
        await this.setAttention(runtime.accountId, conversationId, "pending");
        this.emit(runtime, "reply", { decision, conversationId, ...decision.turn ? { turn: decision.turn } : {}, ...decision.warnings?.length ? { warnings: decision.warnings } : {} });
      } else {
        this.emit(runtime, "reply", { decision, conversationId, ...decision.turn ? { turn: decision.turn } : {}, ...decision.warnings?.length ? { warnings: decision.warnings } : {} });
      }
      runtime.lastReplyAt = Date.now();
      runtime.lastReplyType = decision.type;
    } catch (error) {
      this.emit(runtime, "runtime", {
        replyError: errorMessage(error),
        ...error instanceof ReplyApiError ? { replyErrorCode: error.code } : {},
        conversationId
      });
    }
  }
  async sendTexts(runtime, conversationId, texts) {
    for (const text of texts) {
      if (!text.trim()) continue;
      if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return;
      const correlation = this.trackAutomation(runtime.accountId, conversationId, "text", text);
      try {
        const result = await runtime.transport.invoke("messages.send.text", { conversationId, text });
        if (!result.ok) throw new Error(result.error.message);
        this.completeAutomation(correlation, result.data);
      } catch (error) {
        this.removeAutomation(runtime.accountId, correlation);
        throw error;
      }
    }
  }
  trackAutomation(accountId, conversationId, type, content) {
    const record = { conversationId, type, content, createdAt: Date.now() };
    const records = this.automationOutbounds.get(accountId) || [];
    records.push(record);
    while (records.length > MAX_AUTOMATION_OUTBOUNDS) records.shift();
    this.automationOutbounds.set(accountId, records);
    return record;
  }
  completeAutomation(record, value) {
    const wrapper = asRecord$1(value);
    const message = asRecord$1(wrapper.message || value);
    record.id = scalarString(message.id ?? message.serverId ?? message.messageId) || void 0;
    record.content = scalarString(message.content ?? message.text ?? message.name) || record.content;
  }
  removeAutomation(accountId, record) {
    const records = this.automationOutbounds.get(accountId);
    if (!records) return;
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    if (!records.length) this.automationOutbounds.delete(accountId);
  }
  async transferToOfficialTarget(runtime, conversationId, transfer) {
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: "shop-offline" };
    const requested = transferTargetReference(transfer.target);
    if (!requested) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "official-target-required" };
    }
    const listed = await runtime.transport.invoke("handoff.targets.list", {});
    if (!runtime.online || this.runtimes.get(runtime.accountId) !== runtime) return { transferred: false, reason: "shop-offline" };
    if (!listed.ok || !Array.isArray(listed.data)) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "official-target-list-unavailable" };
    }
    const target = listed.data.map((value) => asRecord$1(value)).find(
      (item) => requested.id && scalarString(item.id) === requested.id || requested.name && scalarString(item.name) === requested.name
    );
    const targetId = target && scalarString(target.id);
    const targetName = target && scalarString(target.name);
    if (!target || !targetId) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: "requested-target-not-in-official-list" };
    }
    const transferred = await runtime.transport.invoke("handoff.transfer", {
      conversationId,
      targetId,
      targetName,
      reason: transfer.reason
    });
    if (!transferred.ok) {
      await this.setAttention(runtime.accountId, conversationId, "pending");
      return { transferred: false, reason: transferred.error.message, target: { id: targetId, name: targetName } };
    }
    return { transferred: true, target: { id: targetId, name: targetName }, reason: transfer.reason };
  }
  emit(runtime, type, payload) {
    const event = { accountId: runtime.accountId, type, timestamp: Date.now(), payload };
    for (const listener of [...this.listeners]) listener(event);
  }
  toSnapshot(runtime) {
    return {
      accountId: runtime.accountId,
      online: runtime.online,
      runtimeState: runtime.runtimeState,
      messageListening: runtime.messageListening,
      lastIncomingAt: runtime.lastIncomingAt,
      lastReplyAt: runtime.lastReplyAt,
      lastReplyType: runtime.lastReplyType,
      attention: Object.fromEntries(runtime.attention)
    };
  }
  require(accountId) {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) throw new Error(`店铺 Runtime 不存在: ${accountId}`);
    return runtime;
  }
}
class HttpShopReplyApi {
  endpoint;
  endpointError;
  fetcher;
  timeoutMs;
  waitBeforeRetry;
  constructor(options = {}) {
    const configuredEndpoint = options.endpoint || process.env.PLATFORM_HUB_REPLY_API_URL || DEFAULT_REPLY_API_URL;
    try {
      this.endpoint = normalizeReplyEndpoint(configuredEndpoint);
    } catch (error) {
      this.endpoint = configuredEndpoint;
      this.endpointError = errorMessage(error);
    }
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs) || positiveInteger(Number(process.env.PLATFORM_HUB_REPLY_API_TIMEOUT_MS)) || 15e3;
    this.waitBeforeRetry = options.waitBeforeRetry || wait;
  }
  async reply(input) {
    if (this.endpointError) throw new ReplyApiError("INVALID_ENDPOINT", `Reply API 地址无效: ${this.endpointError}`);
    const message = asRecord$1(input.message);
    const messageType = scalarString(message.type) || scalarString(message.message_type) || "unknown";
    const body = {
      platform_data: {
        platform_en: input.platform,
        shop_id: input.shopId,
        shop_name: input.shopName,
        customer_name: input.customerName,
        customer_id: input.customerId,
        messages: [{
          user_id: input.customerId,
          name: input.customerName,
          content: input.content,
          message_type: messageType,
          type: messageType,
          from: { id: input.customerId, name: input.customerName }
        }],
        extra_context: {
          account_id: input.accountId,
          conversation_id: input.conversationId,
          message_id: scalarString(message.id)
        }
      }
    };
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250);
          continue;
        }
        throw new ReplyApiError(timeout ? "TIMEOUT" : "NETWORK_ERROR", timeout ? "Reply API 请求超时" : `Reply API 网络失败: ${errorMessage(error)}`);
      }
      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(retryDelay(null, attempt) ?? 250);
          continue;
        }
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ReplyApiError(timeout ? "TIMEOUT" : "NETWORK_ERROR", `读取 Reply API 响应失败: ${errorMessage(error)}`);
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = safeErrorDetail(responseText);
        const retryable = response.status === 429 || [500, 502, 503].includes(response.status);
        const delayMs = retryable ? retryDelay(response.headers.get("retry-after"), attempt) : void 0;
        if (retryable && attempt < maxAttempts && delayMs !== void 0) {
          await this.waitBeforeRetry(delayMs);
          continue;
        }
        throw new ReplyApiError(`HTTP_${response.status}`, detail || `Reply API HTTP ${response.status}`);
      }
      return parseReplyApiBody(responseText);
    }
    throw new ReplyApiError("NETWORK_ERROR", "Reply API 请求失败");
  }
}
const DEFAULT_REPLY_API_URL = "http://192.168.5.3:18021/api/v1/chats/reply";
class ReplyApiError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReplyApiError";
  }
}
function parseReplyApiBody(bodyText) {
  if (!bodyText) throw new ReplyApiError("EMPTY_BODY", "Reply API 返回空 body");
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ReplyApiError("INVALID_JSON", "Reply API 返回非法 JSON");
  }
  const root = asRecord$1(parsed);
  const data = asRecord$1(root.data);
  const turn = Object.keys(asRecord$1(data.turn)).length ? asRecord$1(data.turn) : void 0;
  if (turn?.should_process === false) return { type: "ignore", reason: "turn-should-not-process", turn };
  const lifecycle = asRecord$1(data.lifecycle);
  const actionValue = asRecord$1(lifecycle.action);
  if (Object.keys(actionValue).length) {
    const messages = stringArray(actionValue.messages);
    const warnings2 = Array.isArray(actionValue.messages) && messages.length !== actionValue.messages.length ? ["lifecycle.action.messages 包含非字符串，已丢弃"] : void 0;
    return {
      type: "reply",
      texts: [],
      lifecycleAction: {
        kind: scalarString(actionValue.kind) || "unknown",
        actionId: scalarString(actionValue.action_id),
        messages,
        actionCode: finiteNumber(actionValue.action_code),
        payload: Object.keys(asRecord$1(actionValue.payload)).length ? asRecord$1(actionValue.payload) : void 0
      },
      ...turn ? { turn } : {},
      ...warnings2 ? { warnings: warnings2 } : {}
    };
  }
  if (!Object.prototype.hasOwnProperty.call(data, "ai_reply")) {
    return { type: "ignore", reason: "unrecognized-response", ...turn ? { turn } : {}, warnings: ["响应缺少 data.ai_reply 与 lifecycle.action"] };
  }
  const ai = data.ai_reply;
  if (ai === null) return { type: "ignore", reason: "no-ai-reply", ...turn ? { turn } : {} };
  if (!ai || typeof ai !== "object" || Array.isArray(ai)) return { type: "ignore", reason: "unrecognized-ai-reply", ...turn ? { turn } : {}, warnings: ["data.ai_reply 类型错误，已忽略"] };
  const aiReply = asRecord$1(ai);
  const rawParts = aiReply.reply_parts;
  const texts = stringArray(rawParts);
  const rawFiles = aiReply.file_urls;
  const fileUrls = stringArray(rawFiles).filter(isHttpUrl);
  const transferRaw = asRecord$1(aiReply.transfer);
  const transfer = transferRaw.is_transfer === true ? {
    reason: scalarString(transferRaw.transfer_reason),
    source: scalarString(transferRaw.transfer_source),
    target: transferRaw.transfer_person,
    messages: stringArray(transferRaw.transfer_messages),
    sendGreetingBeforeHandoff: transferRaw.send_greeting_before_handoff === true,
    confidence: finiteNumber(transferRaw.confidence)
  } : void 0;
  const warnings = [];
  if (rawParts != null && !Array.isArray(rawParts)) warnings.push("ai_reply.reply_parts 类型错误，已丢弃");
  else if (Array.isArray(rawParts) && texts.length !== rawParts.length) warnings.push("ai_reply.reply_parts 含非字符串，已丢弃");
  if (rawFiles != null && !Array.isArray(rawFiles)) warnings.push("ai_reply.file_urls 类型错误，已丢弃");
  else if (Array.isArray(rawFiles) && fileUrls.length !== rawFiles.length) warnings.push("ai_reply.file_urls 含无效 URL，已丢弃");
  if (transferRaw.transfer_messages != null && !Array.isArray(transferRaw.transfer_messages)) warnings.push("transfer.transfer_messages 类型错误，已丢弃");
  if (!texts.length && !fileUrls.length && !transfer) return { type: "ignore", reason: "empty-ai-reply", ...turn ? { turn } : {}, ...warnings.length ? { warnings } : {} };
  return {
    type: "reply",
    texts,
    fileUrls,
    ...transfer ? { transfer } : {},
    ...turn ? { turn } : {},
    ...warnings.length ? { warnings } : {}
  };
}
function transferTargetReference(value) {
  if (typeof value === "string" || typeof value === "number") {
    const target = String(value).trim();
    return target ? { id: target, name: target } : void 0;
  }
  const item = asRecord$1(value);
  const id = scalarString(item.id || item.target_id || item.staff_id);
  const name = scalarString(item.name || item.target_name || item.staff_name);
  return id || name ? { id, name } : void 0;
}
async function loadReplyFile(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || isPrivateHostname(parsed.hostname)) throw new Error("Reply API 附件必须使用公网 HTTPS URL");
  const response = await fetch(url, { signal: AbortSignal.timeout(15e3), redirect: "error" });
  if (!response.ok) throw new Error(`读取 Reply API 附件失败: HTTP ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
  if (!mimeType.startsWith("image/")) throw new Error(`当前 Douyin Hook 暂不支持此附件类型: ${mimeType}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 8 * 1024 * 1024) throw new Error("Reply API 附件超过 8 MB 限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Reply API 附件超过 8 MB 限制");
  const base64 = Buffer.from(bytes).toString("base64");
  const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "reply-attachment").slice(0, 180);
  return { dataUrl: `data:${mimeType};base64,${base64}`, name: leaf, mimeType };
}
function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}
function normalizeReplyEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 HTTP / HTTPS");
  if (url.pathname === "/" || !url.pathname) url.pathname = "/api/v1/chats/reply";
  return url.toString();
}
function safeErrorDetail(bodyText) {
  try {
    const value = asRecord$1(JSON.parse(bodyText));
    return scalarString(value.detail) || scalarString(value.message);
  } catch {
    return bodyText.trim().slice(0, 400) || void 0;
  }
}
function retryDelay(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      const delayMs = Math.max(0, seconds * 1e3);
      return delayMs <= 3e4 ? delayMs : void 0;
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const delayMs = Math.max(0, date - Date.now());
      return delayMs <= 3e4 ? delayMs : void 0;
    }
  }
  return Math.min(2e3, 250 * 2 ** (attempt - 1));
}
function wait(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function positiveInteger(value) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : void 0;
}
function asRecord$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function scalarString(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : void 0;
}
function finiteNumber(value) {
  const number = Number(value);
  return value !== void 0 && Number.isFinite(number) ? number : void 0;
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
class PlatformManager {
  constructor(registry, importedFactory) {
    this.registry = registry;
    this.importedFactory = importedFactory;
    this.statePath = join(app.getPath("userData"), "platform-hub.json");
    this.stateBackupPath = join(app.getPath("userData"), "platform-hub.json.bak");
    this.runtimeManager = new PlatformRuntimeManager(registry, (account) => this.runtimeContext(account));
    this.shopRuntimes.onEvent((event) => this.emitRuntimeEvent(event));
  }
  registry;
  importedFactory;
  runtimeManager;
  listeners = /* @__PURE__ */ new Set();
  runtimeUnsubscribers = /* @__PURE__ */ new Map();
  state = { accounts: [], hooks: [] };
  statePath;
  stateBackupPath;
  saveQueue = Promise.resolve();
  shopRuntimes = new ShopRuntimeManager(new HttpShopReplyApi());
  hostWindow = null;
  activeAccountId = "";
  primaryViewportBounds = null;
  async init() {
    this.state = await this.readState(this.statePath) || await this.readState(this.stateBackupPath) || { accounts: [], hooks: [] };
    this.state.accounts = this.state.accounts.map((account) => ({ ...account, online: account.online === true, runtimeState: account.runtimeState || "stopped", messageListening: account.messageListening === true }));
    for (const { manifest } of this.state.hooks) if (!this.registry.has(manifest.id)) this.registry.register(this.importedFactory(manifest));
    for (const account of this.state.accounts) await this.prepareAccount(account);
  }
  async attachMainWindow(window) {
    if (this.hostWindow && this.hostWindow !== window) for (const account of this.state.accounts) this.runtimeManager.detachPrimaryView(account.id);
    this.hostWindow = window;
    for (const account of this.state.accounts) (await this.ensureRuntime(account)).bindHostWindow?.(window);
    for (const account of this.state.accounts.filter((item) => item.online)) await this.setAccountOnline(account.id, true).catch((error) => {
      account.runtimeState = "error";
      console.error(`[platform-hub] 恢复店铺 Runtime 失败: ${account.id}`, error);
    });
    if (this.activeAccountId) await this.open(this.activeAccountId);
  }
  listPlatforms() {
    return this.registry.list().map(({ definition }) => {
      const imported = this.state.hooks.some(({ manifest }) => manifest.id === definition.id);
      return { id: definition.id, label: definition.label, url: definition.url, executionModel: definition.executionModel, capabilities: [...definition.capabilities], hookVersion: definition.version, source: imported ? "imported" : "builtin" };
    });
  }
  listAccounts() {
    return this.state.accounts.map((account) => publicAccount(account, this.runtimeManager.get(account.id)?.getPrimaryWebContentsId?.(), this.shopRuntimes.snapshot(account.id)));
  }
  async addAccount(input) {
    const definition = this.registry.require(input.platform).definition;
    const account = {
      id: randomUUID(),
      platform: definition.id,
      label: input.label.trim() || definition.label,
      url: input.url || definition.url,
      partition: partitionFor(definition.id, randomUUID()),
      connected: false,
      authenticated: false,
      online: false,
      runtimeState: "stopped",
      messageListening: false,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    account.partition = partitionFor(definition.id, account.id);
    await this.prepareAccount(account);
    this.state.accounts.push(account);
    if (this.hostWindow) await this.ensureRuntime(account);
    await this.save();
    return publicAccount(account);
  }
  async removeAccount(accountId) {
    const account = this.requireAccount(accountId);
    await this.shopRuntimes.stop(accountId).catch(() => void 0);
    this.shopRuntimes.unregister(accountId);
    this.runtimeUnsubscribers.get(accountId)?.();
    this.runtimeUnsubscribers.delete(accountId);
    await this.runtimeManager.dispose(accountId).catch(() => void 0);
    await this.registry.require(account.platform).removeAccount?.(account);
    this.state.accounts = this.state.accounts.filter((item) => item.id !== accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = "";
    await this.save();
  }
  async open(accountId) {
    const account = this.requireAccount(accountId);
    for (const other of this.state.accounts) if (other.id !== accountId) this.runtimeManager.detachPrimaryView(other.id);
    const runtime = await this.ensureRuntime(account);
    await runtime.attachPrimaryView();
    this.activeAccountId = accountId;
    const status = await runtime.getStatus();
    applyStatus(account, status);
    account.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save();
    return publicAccount(account, status.webContentsId);
  }
  async connect(accountId, webContentsId) {
    const account = this.requireAccount(accountId);
    const runtime = await this.ensureRuntime(account);
    if (runtime.getPrimaryWebContentsId?.() !== webContentsId) throw new Error("页面 WebContents 与账号不匹配");
    const status = await runtime.getStatus();
    applyStatus(account, status);
    await this.save();
    return toPlatformStatus(account, status);
  }
  async disconnect(accountId) {
    const account = this.requireAccount(accountId);
    await this.shopRuntimes.stop(accountId).catch(() => void 0);
    this.shopRuntimes.unregister(accountId);
    this.runtimeUnsubscribers.get(accountId)?.();
    this.runtimeUnsubscribers.delete(accountId);
    await this.runtimeManager.dispose(accountId);
    Object.assign(account, { connected: false, authenticated: false, webContentsId: void 0, online: false, runtimeState: "stopped", messageListening: false });
    if (this.activeAccountId === accountId) this.activeAccountId = "";
    await this.save();
  }
  async setAccountOnline(accountId, online) {
    const account = this.requireAccount(accountId);
    const runtime = await this.ensureRuntime(account);
    if (online) {
      await runtime.start();
      applyStatus(account, await runtime.getStatus());
      if (this.activeAccountId === accountId) await runtime.attachPrimaryView();
    }
    account.online = online;
    const snapshot = await this.shopRuntimes.setOnline(accountId, online);
    account.runtimeState = snapshot.runtimeState;
    account.messageListening = snapshot.messageListening;
    await this.save();
    return this.listAccounts().find((item) => item.id === accountId) || publicAccount(account);
  }
  runtimeStates() {
    return this.shopRuntimes.snapshots();
  }
  setPrimaryViewportBounds(bounds) {
    this.primaryViewportBounds = { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) };
    if (this.activeAccountId) this.runtimeManager.get(this.activeAccountId)?.updatePrimaryViewBounds?.(this.primaryViewportBounds);
  }
  async setConversationAttention(accountId, conversationId, state) {
    await this.shopRuntimes.setAttention(accountId, conversationId, state);
  }
  async status(accountId) {
    const account = this.requireAccount(accountId);
    const runtime = await this.runtimeManager.start(account);
    const status = await runtime.getStatus();
    applyStatus(account, status);
    await this.save();
    return toPlatformStatus(account, status);
  }
  async collectProducts(accountId) {
    const account = this.requireAccount(accountId);
    const result = await this.invokeOperation(account, "products.list", {});
    return (Array.isArray(result) ? result : []).map((item) => toPlatformProduct(item, account.platform));
  }
  async productDetail(accountId, goodsId) {
    const account = this.requireAccount(accountId);
    return toPlatformProduct(await this.invokeOperation(account, "products.detail", { id: goodsId }), account.platform);
  }
  async sessionsFor(accountId) {
    const result = await this.invokeOperation(this.requireAccount(accountId), "sessions.list", {});
    return (Array.isArray(result) ? result : []).map(toPlatformSession);
  }
  async messagesFor(accountId, sessionId) {
    const result = await this.invokeOperation(this.requireAccount(accountId), "messages.history", { conversationId: sessionId });
    return (Array.isArray(result) ? result : []).map(toPlatformMessage);
  }
  async ordersFor(accountId, userId) {
    const account = this.requireAccount(accountId);
    const result = await this.invokeOperation(account, "orders.list", { userId });
    return (Array.isArray(result) ? result : []).map((item) => toPlatformOrder(item, account.platform));
  }
  async syncOrdersFor(accountId, sessionId, userId) {
    return { orders: await this.ordersFor(accountId, userId), authoritative: true, source: "platform-runtime", syncedAt: Date.now(), sessionId, userId };
  }
  async listenOrdersFor(accountId, sessionId, orderId) {
    return this.invokeOperation(this.requireAccount(accountId), "orders.listen", { conversationId: sessionId, orderId });
  }
  async listenMessagesFor(accountId) {
    return this.invokeOperation(this.requireAccount(accountId), "messages.listen", {});
  }
  async handoffTargetsFor(accountId) {
    return this.invokeOperation(this.requireAccount(accountId), "handoff.targets.list", {});
  }
  async sendMessage(accountId, sessionId, content) {
    await this.invokeOperation(this.requireAccount(accountId), "messages.send.text", { conversationId: sessionId, text: content });
    return { success: true };
  }
  async sendFile(accountId, sessionId, dataUrl, fileName) {
    await this.invokeOperation(this.requireAccount(accountId), "messages.send.file", { conversationId: sessionId, dataUrl, name: fileName, mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] || "image/png" });
    return { success: true };
  }
  async transferSession(accountId, sessionId, target) {
    return this.invokeOperation(this.requireAccount(accountId), "handoff.transfer", { conversationId: sessionId, targetName: target });
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async dispose() {
    for (const account of this.state.accounts) {
      await this.shopRuntimes.stop(account.id).catch(() => void 0);
      this.shopRuntimes.unregister(account.id);
      this.runtimeUnsubscribers.get(account.id)?.();
    }
    this.runtimeUnsubscribers.clear();
    await this.runtimeManager.disposeAll();
    await Promise.all(this.registry.list().map((factory) => factory.dispose?.().catch(() => void 0)));
    this.listeners.clear();
  }
  async importPackage() {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Hook package", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const manifestPath = result.filePaths[0];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest.script && manifest.entry) {
      const packageRoot = dirname(manifestPath);
      const entryPath = resolve(packageRoot, manifest.entry);
      if (relative(packageRoot, entryPath).startsWith("..")) throw new Error("Hook 包 entry 不能指向包目录之外");
      manifest.script = await readFile(entryPath, "utf8");
    }
    if (!manifest.id || !manifest.script || !manifest.url || !Array.isArray(manifest.capabilities)) throw new Error("Hook 包 manifest 缺少必要字段");
    this.state.hooks = [...this.state.hooks.filter((item) => item.manifest.id !== manifest.id), { manifest, filePath: manifestPath }];
    if (!this.registry.has(manifest.id)) this.registry.register(this.importedFactory(manifest));
    await this.save();
    return this.listPlatforms().find((item) => item.id === manifest.id) || null;
  }
  async prepareAccount(account) {
    const setup = await this.registry.require(account.platform).prepareAccount?.(account);
    if (setup) Object.assign(account, setup);
  }
  async ensureRuntime(account) {
    const adapter = await this.runtimeManager.ensure(account);
    if (!this.shopRuntimes.has(account.id)) {
      this.shopRuntimes.register(account.id, adapter.transport, { platform: account.platform, shopName: account.label });
      this.runtimeUnsubscribers.set(account.id, adapter.transport.subscribe((event) => this.onRuntimeEvent(account.id, event)));
    }
    return adapter;
  }
  async invokeOperation(account, operation, input) {
    const runtime = await this.ensureRuntime(account);
    await runtime.start();
    let result = await runtime.transport.invoke(operation, input);
    if (!result.ok) {
      if (result.error.code === "CHALLENGE_REQUIRED") {
        await runtime.showOperationPage?.(operation);
        throw codedError(result.error.code, result.error.message);
      }
      if (result.error.code === "LOGIN_REQUIRED") {
        await runtime.showOperationPage?.(operation);
        await runtime.waitForLogin?.(operation);
        result = await runtime.transport.invoke(operation, input);
      } else if (result.error.code === "RUNTIME_NOT_READY") {
        await runtime.showOperationPage?.(operation);
        result = await runtime.transport.invoke(operation, input);
      }
    }
    if (!result.ok) throw codedError(result.error.code, result.error.message);
    return result.data;
  }
  runtimeContext(account) {
    const stored = this.requireAccount(account.id);
    return {
      getAccount: () => stored,
      getHostWindow: () => this.hostWindow,
      getPrimaryViewBounds: () => this.primaryViewportBounds,
      updateAccount: (patch) => {
        Object.assign(stored, patch);
        void this.save();
      }
    };
  }
  onRuntimeEvent(accountId, event) {
    const account = this.state.accounts.find((item) => item.id === accountId);
    if (!account) return;
    const payload = asRecord(event.payload);
    let type = "log";
    let publicPayload = event.payload;
    if (event.type === "message.created") {
      type = "message";
      publicPayload = { message: toPlatformMessage(payload.message) };
    } else if (event.type.startsWith("order.")) {
      type = "order";
      publicPayload = { ...payload, order: toPlatformOrder(payload.order, account.platform), eventType: event.type };
    } else if (event.type === "auth.changed") {
      type = "connection";
      const auth = asRecord(payload.auth);
      account.authenticated = auth.authenticated === true;
      account.lastSeenAt = new Date(event.timestamp).toISOString();
      publicPayload = toPlatformStatus(account, { connected: account.connected, authenticated: account.authenticated, url: account.url, message: account.authenticated ? "平台已登录，Runtime 已就绪" : "请在当前平台页面完成登录" });
      void this.save();
      if (account.online && account.authenticated && this.shopRuntimes.snapshot(accountId)?.runtimeState !== "running") void this.setAccountOnline(accountId, true).catch(() => void 0);
    } else if (event.type === "runtime.error") type = "error";
    this.publish({ id: event.id || `${accountId}:runtime:${event.timestamp}:${randomUUID()}`, accountId, platform: account.platform, type, timestamp: event.timestamp, payload: publicPayload });
  }
  emitRuntimeEvent(event) {
    const account = this.state.accounts.find((item) => item.id === event.accountId);
    if (!account) return;
    const hookEvent = event.type === "hook" && event.payload.event && typeof event.payload.event === "object" ? event.payload.event : void 0;
    const type = hookEvent?.type || event.type;
    const payload = hookEvent?.payload ?? event.payload;
    const eventType = type === "message.created" ? "message" : type.startsWith("order.") ? "order" : type === "auth.changed" ? "connection" : type === "runtime.error" ? "error" : "log";
    this.publish({ id: `${event.accountId}:runtime:${event.timestamp}:${randomUUID()}`, accountId: event.accountId, platform: account.platform, type: eventType, timestamp: event.timestamp, payload: type === "message.created" ? { message: toPlatformMessage(asRecord(payload).message) } : payload });
  }
  publish(event) {
    this.listeners.forEach((listener) => listener(event));
  }
  requireAccount(id) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) throw new Error("平台账号不存在");
    return account;
  }
  async readState(path) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      return Array.isArray(value.accounts) && Array.isArray(value.hooks) ? { accounts: value.accounts, hooks: value.hooks } : null;
    } catch {
      return null;
    }
  }
  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const operation = this.saveQueue.catch(() => void 0).then(async () => {
      const directory = app.getPath("userData");
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true });
      const current = await readFile(this.statePath, "utf8").catch(() => "");
      if (current) await writeFile(this.stateBackupPath, current, "utf8").catch(() => void 0);
      await writeFile(temporaryPath, snapshot, "utf8");
      await rename(temporaryPath, this.statePath);
    });
    this.saveQueue = operation;
    return operation;
  }
}
function publicAccount(account, liveWebContentsId, snapshot) {
  return { id: account.id, platform: account.platform, label: account.label, url: account.url, partition: account.partition, webContentsId: liveWebContentsId || account.webContentsId, connected: account.connected, authenticated: account.authenticated, online: snapshot?.online ?? account.online, runtimeState: snapshot?.runtimeState ?? account.runtimeState, messageListening: snapshot?.messageListening ?? account.messageListening, lastSeenAt: account.lastSeenAt, createdAt: account.createdAt };
}
function applyStatus(account, status) {
  account.connected = status.connected;
  account.authenticated = status.authenticated;
  account.webContentsId = status.webContentsId;
}
function toPlatformStatus(account, status) {
  return { accountId: account.id, platform: account.platform, connected: status.connected, authenticated: status.authenticated, url: status.url || account.url, title: status.title, message: status.message };
}
function toPlatformProduct(value, platform) {
  const product = asRecord(value);
  const price = asRecord(product.price);
  const skus = Array.isArray(product.skus) ? product.skus : Array.isArray(product.skuList) ? product.skuList : [];
  return { id: stringValue(product.id ?? product.externalId ?? product.goodsId), goodsId: stringValue(product.externalId ?? product.goodsId ?? product.id), name: stringValue(product.title ?? product.name), price: Number(price.amount ?? product.price) || 0, originalPrice: Number(asRecord(product.originalPrice).amount ?? product.originalPrice) || void 0, stockQuantity: Number(product.stockQuantity) || void 0, status: stringValue(product.status), images: Array.isArray(product.images) ? product.images.map(String) : [], goodsUrl: stringValue(product.url ?? product.goodsUrl) || void 0, editUrl: stringValue(product.editUrl) || void 0, shopId: stringValue(product.shopId) || void 0, platform, updatedAt: Number(product.updatedAt) || void 0, description: stringValue(product.description) || void 0, skuList: skus.map((item) => {
    const sku = asRecord(item);
    return { skuId: stringValue(sku.externalId ?? sku.skuId ?? sku.id), skuName: stringValue(sku.name ?? sku.skuName), skuPrice: Number(asRecord(sku.price).amount ?? sku.price ?? sku.skuPrice) || 0 };
  }), raw: asRecord(product.raw) };
}
function toPlatformSession(value) {
  const session = asRecord(value);
  return { id: stringValue(session.id ?? session.conversationId), title: stringValue(session.title ?? session.name), unread: Number(session.unreadCount ?? session.unread) || 0, lastMessage: stringValue(session.lastMessage) || void 0, updatedAt: Number(session.updatedAt) || void 0, avatar: stringValue(session.avatarUrl ?? session.avatar) || void 0 };
}
function toPlatformMessage(value) {
  const message = asRecord(value);
  const direction = message.direction === "outbound" || message.isMine === true ? "outbound" : "inbound";
  return { id: stringValue(message.id ?? message.messageId), sessionId: stringValue(message.conversationId ?? message.sessionId), senderId: stringValue(message.senderId), senderName: stringValue(message.senderName), content: stringValue(message.content ?? message.text), type: stringValue(message.type) || "unknown", isMine: direction === "outbound", direction, origin: normalizeOrigin(message.origin), timestamp: Number(message.timestamp) || Date.now(), avatar: stringValue(message.avatar) || void 0, raw: asRecord(message.raw) };
}
function toPlatformOrder(value, platform) {
  const order = asRecord(value);
  const first = asRecord(Array.isArray(order.items) ? order.items[0] : void 0);
  const total = asRecord(order.total);
  const buyer = asRecord(order.buyer);
  const receiver = asRecord(order.receiver);
  return { id: stringValue(order.id ?? order.externalId ?? order.orderId), orderId: stringValue(order.externalId ?? order.orderId ?? order.id), status: stringValue(order.status) || "unknown", totalAmount: Number(total.amount ?? order.totalAmount) || void 0, quantity: Number(first.quantity ?? order.quantity) || void 0, productId: stringValue(first.productId ?? first.externalProductId ?? order.productId) || void 0, productName: stringValue(first.title ?? order.productName) || void 0, shopId: stringValue(order.shopId) || void 0, sessionId: stringValue(order.conversationId ?? order.sessionId) || void 0, userId: stringValue(buyer.id ?? order.userId) || void 0, buyerName: stringValue(buyer.name ?? order.buyerName) || void 0, receiverName: stringValue(receiver.name ?? order.receiverName) || void 0, shippingAddress: stringValue(receiver.address ?? order.shippingAddress) || void 0, updatedAt: Number(order.updatedAt) || void 0, platform, raw: asRecord(order.raw) };
}
function normalizeOrigin(value) {
  return value === "customer" || value === "human" || value === "automation" || value === "system" ? value : "unknown";
}
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
function partitionFor(platform, accountId) {
  return `persist:platform-hub-${platform}-${accountId.replace(/[^a-z0-9_-]/gi, "_")}`;
}
const EVENT_POLL_INTERVAL_MS = 800;
const AUTH_POLL_INTERVAL_MS = 15e3;
const UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS = 2e3;
const RUNTIME_PAGE_IDLE_MS = 2 * 6e4;
class CdpSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.window = options.hostWindow;
  }
  options;
  window;
  primaryView = null;
  primaryAttached = false;
  contents = null;
  runtimeWindows = /* @__PURE__ */ new Map();
  runtimeWindowIdleTimers = /* @__PURE__ */ new Map();
  connected = false;
  authenticated = false;
  destroyed = false;
  opening = null;
  primaryNavigation = null;
  pollTimer = null;
  pollInFlight = false;
  pollGeneration = 0;
  lastAuthPollAt = 0;
  async open(_show = true) {
    if (this.destroyed) throw new Error("CDP 会话已销毁");
    if (this.primaryView?.webContents.isDestroyed()) {
      this.detachPrimaryView();
      this.primaryView = null;
      this.contents = null;
      this.connected = false;
      this.stopRuntimePolling();
    }
    if (this.primaryView && !this.primaryView.webContents.isDestroyed()) {
      if (this.opening) await this.opening;
      return;
    }
    if (this.window.isDestroyed()) throw new Error("主工作台窗口已销毁");
    this.primaryView = new WebContentsView({
      webPreferences: {
        partition: this.options.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    });
    this.primaryAttached = false;
    this.primaryView.setVisible(false);
    this.contents = this.primaryView.webContents;
    this.contents.setWindowOpenHandler(({ url }) => {
      if (this.isLoginUrl(url)) {
        void this.contents?.loadURL(url).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
      }
      return { action: "deny" };
    });
    this.contents.on("did-finish-load", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("did-navigate", () => this.reinstallPrimaryHook(this.contents));
    this.contents.on("render-process-gone", (_event, details) => this.emitError(`页面进程退出: ${details.reason}`));
    const opening = this.contents.loadURL(this.options.url).then(() => this.installHook(this.contents, true));
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }
  async installHook(contents = this.contents, primary = true, pageId = primary ? "primary" : void 0) {
    if (!contents || contents.isDestroyed()) return;
    if (!this.options.hook.script) throw new Error("Hook 包没有可执行脚本");
    if (pageId) await this.evaluate(contents, `globalThis.__PLATFORM_HOOK_PAGE_ID__ = ${JSON.stringify(pageId)}`);
    await this.evaluate(contents, this.options.hook.script);
    if (primary) {
      this.connected = true;
      this.startRuntimePolling();
      this.emitStatus("Hook 已通过 CDP 注入，等待平台事件");
      const diagnosis = await this.invoke("diagnose").catch(() => []);
      console.info(`[platform-hub] ${this.options.platform} window runtime`, diagnosis);
    }
  }
  async waitForLogin(timeoutMs = 15 * 6e4, method) {
    const route = method ? this.routeForMethod(method) : void 0;
    const contents = route ? await this.openRuntimePage(route) : this.contents;
    if (!contents || contents.isDestroyed()) throw new Error("页面尚未连接，请先打开平台页面");
    const started = Date.now();
    while (!this.destroyed && Date.now() - started < timeoutMs) {
      const result = await this.evaluate(
        contents,
        `window.__platformHub && window.__platformHub.getAuthState()`
      ).catch(() => null);
      const authenticated = result?.authenticated === true || result?.isLogin === true || result?.loggedIn === true || Boolean(result?.shopId || result?.userId);
      if (!route) this.markAuthenticated(authenticated);
      if (authenticated) {
        if (!route) await this.ensurePrimaryRuntimePage();
        return;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    }
    throw new Error("等待平台登录超时，请完成登录后重试");
  }
  async invoke(method, ...args) {
    const route = this.routeForMethod(method);
    try {
      const contents = await this.contentsForMethod(method);
      return await this.evaluate(
        contents,
        `window.__platformHub && window.__platformHub[${JSON.stringify(method)}](...${JSON.stringify(args)})`
      );
    } finally {
      if (route && !route.persistent) this.scheduleRuntimeWindowClose(route.id);
    }
  }
  bindHostWindow(window) {
    if (this.window === window) return;
    this.detachPrimaryView();
    this.window = window;
  }
  hasPrimaryView() {
    return Boolean(this.primaryView && !this.primaryView.webContents.isDestroyed());
  }
  isPrimaryViewAttached() {
    return this.primaryAttached && this.hasPrimaryView();
  }
  attachPrimaryView() {
    if (this.destroyed) throw new Error("CDP 会话已销毁");
    const view = this.primaryView;
    if (!view || view.webContents.isDestroyed()) throw new Error("主页面尚未创建，请先打开平台页面");
    if (this.window.isDestroyed()) throw new Error("主工作台窗口已销毁");
    if (this.primaryAttached) return;
    this.window.contentView.addChildView(view);
    this.primaryAttached = true;
    view.setVisible(true);
  }
  detachPrimaryView() {
    const view = this.primaryView;
    if (!view) {
      this.primaryAttached = false;
      return;
    }
    if (this.primaryAttached && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    this.primaryAttached = false;
    if (!view.webContents.isDestroyed()) view.setVisible(false);
  }
  setPrimaryBounds(bounds) {
    if (this.primaryAttached && this.primaryView && !this.primaryView.webContents.isDestroyed()) this.primaryView.setBounds(bounds);
  }
  async showRuntimePageFor(method) {
    const route = this.routeForMethod(method);
    if (!route) {
      await this.ensurePrimaryRuntimePage();
      return;
    }
    await this.openRuntimePage(route);
    const target = this.runtimeWindows.get(route.id);
    if (target && !target.isDestroyed()) {
      this.clearRuntimeWindowTimer(route.id);
      target.show();
      target.focus();
    }
  }
  getWebContentsId() {
    return this.contents && !this.contents.isDestroyed() ? this.contents.id : void 0;
  }
  getStatus() {
    return {
      accountId: this.options.accountId,
      platform: this.options.platform,
      connected: this.connected,
      authenticated: this.authenticated,
      url: this.contents?.getURL() || this.options.url,
      title: this.contents?.getTitle(),
      message: this.connected ? this.authenticated ? "已登录并监听中" : "页面已连接，等待登录" : "页面未连接"
    };
  }
  async refreshStatus() {
    const state = await this.invoke("getAuthState").catch(() => null);
    const authenticated = state?.authenticated === true || state?.isLogin === true || state?.loggedIn === true || Boolean(state?.shopId || state?.userId);
    this.markAuthenticated(authenticated);
    if (authenticated) await this.ensurePrimaryRuntimePage();
    return this.getStatus();
  }
  markAuthenticated(value) {
    if (this.authenticated === value) return;
    this.authenticated = value;
    this.emitStatus(value ? "已检测到登录状态" : "需要登录平台账号");
  }
  close() {
    this.destroyed = true;
    this.stopRuntimePolling();
    this.closeRuntimeWindows();
    if (this.primaryView) {
      this.detachPrimaryView();
      if (!this.primaryView.webContents.isDestroyed()) this.primaryView.webContents.close();
    }
    this.primaryAttached = false;
    this.primaryView = null;
    this.contents = null;
    this.removeAllListeners();
  }
  startRuntimePolling() {
    this.stopRuntimePolling();
    this.lastAuthPollAt = 0;
    this.pollTimer = setInterval(() => {
      void this.pollRuntime();
    }, EVENT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    void this.pollRuntime();
  }
  stopRuntimePolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollGeneration += 1;
    this.pollInFlight = false;
  }
  async pollRuntime() {
    const contents = this.contents;
    if (this.destroyed || this.pollInFlight || !contents || contents.isDestroyed()) return;
    const now = Date.now();
    const authPollInterval = this.authenticated ? AUTH_POLL_INTERVAL_MS : UNAUTHENTICATED_AUTH_POLL_INTERVAL_MS;
    const includeAuth = now - this.lastAuthPollAt >= authPollInterval;
    if (includeAuth) this.lastAuthPollAt = now;
    const generation = this.pollGeneration;
    this.pollInFlight = true;
    try {
      const targets = [{ contents, includeAuth }];
      for (const [id, target] of this.runtimeWindows) {
        const route = this.options.hook.runtimePages?.find((page) => page.id === id);
        if (!route?.persistent || target.isDestroyed()) continue;
        targets.push({ contents: target.webContents, includeAuth: false });
      }
      const results = await Promise.all(targets.map(async (target) => {
        if (target.contents.isDestroyed()) return null;
        try {
          return await this.evaluate(target.contents, this.runtimePollExpression(target.includeAuth));
        } catch {
          return null;
        }
      }));
      if (generation !== this.pollGeneration || contents !== this.contents || contents.isDestroyed()) return;
      const primary = results[0];
      if (primary?.auth) this.applyAuthState(primary.auth);
      for (const result of results) for (const item of result?.events || []) this.emitRuntimeEvent(item);
    } catch {
    } finally {
      if (generation === this.pollGeneration) this.pollInFlight = false;
    }
  }
  runtimePollExpression(includeAuth) {
    return `(async () => {
      const api = window.__platformHub
      if (!api) return { auth: null, events: [] }
      const safely = async (method, fallback) => {
        try { return typeof api[method] === 'function' ? await api[method]() : fallback } catch { return fallback }
      }
      return {
        auth: ${includeAuth ? "await safely('getAuthState', null)" : "null"},
        events: await safely('drainEvents', []),
      }
    })()`;
  }
  applyAuthState(record) {
    const authenticated = record.authenticated === true || record.isLogin === true || record.loggedIn === true || Boolean(record.shopId || record.userId);
    if (authenticated === this.authenticated) return;
    this.markAuthenticated(authenticated);
    if (authenticated) void this.ensurePrimaryRuntimePage().catch((error) => this.emitError(`进入消息接待页失败: ${String(error)}`));
  }
  emitRuntimeEvent(item) {
    this.options.emit({
      id: `${this.options.accountId}:${item.type}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: item.type === "message" ? "message" : item.type === "order" ? "order" : item.type === "error" ? "error" : "log",
      timestamp: item.timestamp || Date.now(),
      payload: item.payload
    });
  }
  routeForMethod(method) {
    return this.options.hook.runtimePages?.find((page) => page.methods.includes(method));
  }
  async ensurePrimaryRuntimePage() {
    if (this.window.isDestroyed() || !this.contents || this.contents.isDestroyed()) {
      throw new Error("页面尚未连接，请先打开平台页面");
    }
    if (this.sameRuntimePage(this.contents.getURL(), this.options.hook.url)) return;
    if (this.primaryNavigation) return this.primaryNavigation;
    const navigation = (async () => {
      this.emitStatus("登录成功，正在进入消息接待页");
      await this.contents.loadURL(this.options.hook.url);
      if (!this.contents || this.contents.isDestroyed()) throw new Error("消息接待页加载后连接已失效");
      await this.installHook(this.contents, true);
      this.emitStatus("已进入消息接待页并开始监听");
    })();
    this.primaryNavigation = navigation;
    try {
      await navigation;
    } finally {
      if (this.primaryNavigation === navigation) this.primaryNavigation = null;
    }
  }
  sameRuntimePage(current, expected) {
    try {
      const left = new URL(current);
      const right = new URL(expected);
      return left.origin === right.origin && left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
    } catch {
      return current === expected;
    }
  }
  reinstallHook(contents, primary, pageId) {
    void this.installHook(contents, primary, pageId).catch((error) => this.emitError(`Hook 注入失败: ${String(error)}`));
  }
  reinstallPrimaryHook(contents) {
    if (!contents || contents.isDestroyed()) return;
    const loginUrl = this.loginUrlFor(contents.getURL());
    if (loginUrl && !this.window.isDestroyed()) {
      this.emitStatus("正在打开平台官方登录页");
      void this.contents?.loadURL(loginUrl).catch((error) => this.emitError(`打开登录页失败: ${String(error)}`));
      return;
    }
    this.reinstallHook(contents, true);
  }
  loginUrlFor(currentUrl) {
    const loginUrl = this.options.hook.loginUrl;
    if (!loginUrl) return void 0;
    const patterns = this.options.hook.loginMatch || [];
    return patterns.some((pattern) => this.matchesUrl(currentUrl, pattern)) ? loginUrl : void 0;
  }
  isLoginUrl(url) {
    const loginUrl = this.options.hook.loginUrl;
    if (!loginUrl) return false;
    try {
      return new URL(url).origin === new URL(loginUrl).origin;
    } catch {
      return false;
    }
  }
  matchesUrl(url, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(url);
  }
  async contentsForMethod(method) {
    const route = this.routeForMethod(method);
    if (!route) {
      if (!this.contents || this.contents.isDestroyed()) throw new Error("页面尚未连接，请先打开平台页面");
      return this.contents;
    }
    return this.openRuntimePage(route);
  }
  async openRuntimePage(route) {
    let target = this.runtimeWindows.get(route.id);
    if (!target || target.isDestroyed()) {
      target = new BrowserWindow({
        width: 1260,
        height: 820,
        show: false,
        title: `${this.options.platform} · ${route.id}`,
        webPreferences: {
          partition: this.options.partition,
          contextIsolation: false,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false
        }
      });
      this.runtimeWindows.set(route.id, target);
      const contents = target.webContents;
      contents.on("did-finish-load", () => this.reinstallHook(contents, false, route.id));
      contents.on("render-process-gone", (_event, details) => this.emitError(`${route.id} 页面进程退出: ${details.reason}`));
      target.on("closed", () => {
        this.clearRuntimeWindowTimer(route.id);
        this.runtimeWindows.delete(route.id);
      });
      await this.loadRuntimeUrl(target, route.url);
    } else if (route.refreshBeforeInvoke) {
      await this.loadRuntimeUrl(target, route.url);
    }
    await this.installHook(target.webContents, false, route.id);
    return target.webContents;
  }
  async loadRuntimeUrl(target, url) {
    try {
      await target.loadURL(url);
    } catch (error) {
      if (target.isDestroyed()) throw error;
      const currentUrl = target.webContents.getURL();
      const redirected = currentUrl && currentUrl !== "about:blank" && currentUrl !== url;
      if (!redirected || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
  scheduleRuntimeWindowClose(id) {
    this.clearRuntimeWindowTimer(id);
    const timer = setTimeout(() => {
      this.runtimeWindowIdleTimers.delete(id);
      const target = this.runtimeWindows.get(id);
      if (target && !target.isDestroyed()) target.close();
    }, RUNTIME_PAGE_IDLE_MS);
    timer.unref?.();
    this.runtimeWindowIdleTimers.set(id, timer);
  }
  clearRuntimeWindowTimer(id) {
    const timer = this.runtimeWindowIdleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.runtimeWindowIdleTimers.delete(id);
  }
  closeRuntimeWindows() {
    for (const timer of this.runtimeWindowIdleTimers.values()) clearTimeout(timer);
    this.runtimeWindowIdleTimers.clear();
    for (const target of this.runtimeWindows.values()) if (!target.isDestroyed()) target.close();
    this.runtimeWindows.clear();
  }
  async evaluate(contents, expression) {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const response = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP Runtime.evaluate 执行失败");
    }
    return response.result?.value;
  }
  emitStatus(message) {
    const status = this.getStatus();
    this.options.emit({
      id: `${this.options.accountId}:status:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: "connection",
      timestamp: Date.now(),
      payload: { ...status, message }
    });
  }
  emitError(message) {
    this.options.emit({
      id: `${this.options.accountId}:error:${Date.now()}`,
      accountId: this.options.accountId,
      platform: this.options.platform,
      type: "error",
      timestamp: Date.now(),
      payload: { message }
    });
  }
}
function createPlatformRegistry() {
  const registry = new PlatformRegistry();
  registry.register(createDouyinRuntimeFactory({ createCdpSession: (account, context, emit) => createCdpSession(account, context, douyinHook, emit) }));
  registry.register(createPageRuntimeFactory({
    manifest: kuaishouHook,
    createRuntime: (account, context, emit) => createCdpSession(account, context, kuaishouHook, emit)
  }));
  registry.register(createGoofishRuntimeFactory(app.getPath("userData")));
  return registry;
}
function createImportedHookFactory(manifest) {
  return createPageRuntimeFactory({
    manifest: { ...manifest, capabilities: [...manifest.capabilities], source: "imported" },
    createRuntime: (account, context, emit) => createCdpSession(account, context, manifest, emit)
  });
}
function createCdpSession(account, context, hook, emit) {
  const window = context.getHostWindow();
  if (!window || window.isDestroyed()) throw new Error("主工作台窗口尚未就绪");
  return new CdpSession({
    accountId: account.id,
    platform: account.platform,
    url: account.url,
    partition: account.partition,
    hook,
    hostWindow: window,
    emit: (event) => emit(event)
  });
}
if (process.env.PLATFORM_HUB_USER_DATA) {
  app.setPath("userData", process.env.PLATFORM_HUB_USER_DATA);
}
if (process.env.PLATFORM_HUB_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
}
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PLATFORM_HUB_CDP_PORT || "9333");
}
let mainWindow = null;
const manager = new PlatformManager(createPlatformRegistry(), createImportedHookFactory);
function assertRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("未经授权的 IPC 调用");
}
function createWindow(load = true) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f4f7fb",
    webPreferences: { preload: join(__dirname, "../preload/index.mjs"), contextIsolation: true, sandbox: false }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (load) loadRenderer(mainWindow);
  return mainWindow;
}
function loadRenderer(window) {
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}
function registerIpc() {
  ipcMain.handle("platforms:list", (event) => {
    assertRenderer(event);
    return manager.listPlatforms();
  });
  ipcMain.handle("platforms:import", async (event) => {
    assertRenderer(event);
    return manager.importPackage();
  });
  ipcMain.handle("accounts:list", (event) => {
    assertRenderer(event);
    return manager.listAccounts();
  });
  ipcMain.handle("accounts:add", (event, input) => {
    assertRenderer(event);
    return manager.addAccount(input);
  });
  ipcMain.handle("accounts:remove", (event, id) => {
    assertRenderer(event);
    return manager.removeAccount(id);
  });
  ipcMain.handle("accounts:open", (event, id) => {
    assertRenderer(event);
    return manager.open(id);
  });
  ipcMain.handle("accounts:setOnline", (event, id, online) => {
    assertRenderer(event);
    return manager.setAccountOnline(id, online);
  });
  ipcMain.handle("runtime:states", (event) => {
    assertRenderer(event);
    return manager.runtimeStates();
  });
  ipcMain.handle("conversation:attention:set", (event, id, conversationId, state) => {
    assertRenderer(event);
    return manager.setConversationAttention(id, conversationId, state);
  });
  ipcMain.handle("viewport:bounds", (event, bounds) => {
    assertRenderer(event);
    return manager.setPrimaryViewportBounds(bounds);
  });
  ipcMain.handle("platform:connect", (event, id, webContentsId) => {
    assertRenderer(event);
    return manager.connect(id, webContentsId);
  });
  ipcMain.handle("platform:disconnect", (event, id) => {
    assertRenderer(event);
    return manager.disconnect(id);
  });
  ipcMain.handle("platform:status", (event, id) => {
    assertRenderer(event);
    return manager.status(id);
  });
  ipcMain.handle("products:collect", (event, id) => {
    assertRenderer(event);
    return manager.collectProducts(id);
  });
  ipcMain.handle("products:detail", (event, id, goodsId) => {
    assertRenderer(event);
    return manager.productDetail(id, goodsId);
  });
  ipcMain.handle("sessions:list", (event, id) => {
    assertRenderer(event);
    return manager.sessionsFor(id);
  });
  ipcMain.handle("messages:list", (event, id, sessionId) => {
    assertRenderer(event);
    return manager.messagesFor(id, sessionId);
  });
  ipcMain.handle("orders:list", (event, id, userId) => {
    assertRenderer(event);
    return manager.ordersFor(id, userId);
  });
  ipcMain.handle("orders:sync", (event, id, sessionId, userId) => {
    assertRenderer(event);
    return manager.syncOrdersFor(id, sessionId, userId);
  });
  ipcMain.handle("orders:listen", (event, id, sessionId, orderId) => {
    assertRenderer(event);
    return manager.listenOrdersFor(id, sessionId, orderId);
  });
  ipcMain.handle("messages:listen", (event, id) => {
    assertRenderer(event);
    return manager.listenMessagesFor(id);
  });
  ipcMain.handle("handoff:targets", (event, id) => {
    assertRenderer(event);
    return manager.handoffTargetsFor(id);
  });
  ipcMain.handle("message:send", (event, id, sessionId, content) => {
    assertRenderer(event);
    return manager.sendMessage(id, sessionId, content);
  });
  ipcMain.handle("message:file", (event, id, sessionId, dataUrl, fileName) => {
    assertRenderer(event);
    return manager.sendFile(id, sessionId, dataUrl, fileName);
  });
  ipcMain.handle("session:transfer", (event, id, sessionId, target) => {
    assertRenderer(event);
    return manager.transferSession(id, sessionId, target);
  });
}
app.whenReady().then(async () => {
  await manager.init();
  createWindow(false);
  if (mainWindow) await manager.attachMainWindow(mainWindow);
  if (!manager.listAccounts().length) {
    const initialPlatform = manager.listPlatforms()[0];
    if (initialPlatform) await manager.addAccount({ platform: initialPlatform.id, label: `${initialPlatform.label}主账号` });
  }
  registerIpc();
  manager.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("platform:event", event);
  });
  if (mainWindow) loadRenderer(mainWindow);
  const initialAccount = manager.listAccounts()[0];
  if (initialAccount) void manager.open(initialAccount.id).catch((error) => console.error("[platform-hub] 打开平台页面失败", error));
  app.on("activate", () => {
    if (!mainWindow) {
      const window = createWindow(false);
      void manager.attachMainWindow(window).then(() => loadRenderer(window));
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let shuttingDown = false;
let shutdownComplete = false;
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void manager.dispose().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
