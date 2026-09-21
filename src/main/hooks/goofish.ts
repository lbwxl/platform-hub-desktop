import type { HookPackageManifest, PlatformCapability } from '../../shared/platform'

const capabilities: PlatformCapability[] = ['messages.listen', 'messages.history', 'messages.send', 'messages.file', 'sessions.list', 'products.collect', 'products.detail']

/** 导入闲鱼原有 bridge 后的统一入口；真正的 bridge 可替换，不让 UI 依赖实现细节。 */
export const goofishHook: HookPackageManifest = {
  id: 'goofish', label: '闲鱼', version: '1.0.0', url: 'https://www.goofish.com/', executionModel: 'page',
  capabilities, source: 'builtin',
  script: `(() => {
    const bridge = window.__GOOFISH_BRIDGE__ || window.__goofishBridge
    const api = window.__platformHub || {}
    if (!bridge) return
    window.__platformHub = { ...api, __version: '2',
      getAuthState: () => bridge.snapshot?.() || { authenticated: true },
      collectProducts: () => bridge.listOnSaleProducts?.() || [],
      listSessions: () => bridge.listSessions?.() || [],
      listMessages: (id) => bridge.listMessages?.(id) || [],
      sendMessage: (id, text) => bridge.sendMessage?.(id, text),
      sendFile: (id, data, name) => bridge.sendFile?.(id, data, name),
      drainEvents: () => bridge.drainEvents?.() || []
    }
  })()`
}
