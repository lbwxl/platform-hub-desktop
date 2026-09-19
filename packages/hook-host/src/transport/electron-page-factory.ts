import { createRequire } from 'node:module'
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron'
import type { PageHookRuntime } from '@platform-hub/hook-sdk'
import type { HookPageAdapter, HookPageContext, HookPageFactory } from '../pages/types.js'

export interface ElectronPageFactoryOptions {
  /** Injects the platform supplied PageHookRuntime through CDP/window runtime. */
  installRuntime(context: HookPageContext, contents: WebContents): Promise<PageHookRuntime>
  /** Optional readiness check used after a user completes an official challenge. */
  isRuntimeReady?(context: HookPageContext, contents: WebContents): Promise<boolean>
  createWindow?(context: HookPageContext): BrowserWindow
  windowOptions?: Omit<BrowserWindowConstructorOptions, 'webPreferences'>
}

/** BrowserWindow ownership stays in Host; a platform only supplies runtime installation. */
export class ElectronHookPageFactory implements HookPageFactory {
  constructor(private readonly options: ElectronPageFactoryOptions) {}

  async create(context: HookPageContext): Promise<HookPageAdapter> {
    const window = this.options.createWindow?.(context) || newBrowserWindow({
      ...this.options.windowOptions,
      show: context.definition.kind === 'primary',
      title: `${context.manifest.platform} · ${context.definition.id}`,
      webPreferences: {
        partition: context.partition,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const page = new ElectronHookPageAdapter(context, window, this.options)
    await page.load()
    return page
  }
}

function newBrowserWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  // Keep the generic Host importable in Node test processes; Electron is loaded only when a page is created.
  const require = createRequire(import.meta.url)
  const { BrowserWindow: ElectronBrowserWindow } = require('electron') as typeof import('electron')
  return new ElectronBrowserWindow(options)
}

class ElectronHookPageAdapter implements HookPageAdapter {
  readonly id: string
  readonly partition: string
  readonly definition: HookPageContext['definition']
  private alive = true
  private runtime?: PageHookRuntime

  constructor(
    private readonly context: HookPageContext,
    private readonly window: BrowserWindow,
    private readonly options: ElectronPageFactoryOptions,
  ) {
    this.id = context.definition.id
    this.partition = context.partition
    this.definition = context.definition
    this.window.on('closed', () => { this.alive = false })
  }

  async load(): Promise<void> {
    if (this.definition.url) await this.window.loadURL(this.definition.url)
  }

  async installRuntime(): Promise<PageHookRuntime> {
    if (!this.alive || this.window.isDestroyed()) throw new Error(`页面 ${this.id} 已关闭`)
    this.runtime = await this.options.installRuntime(this.context, this.window.webContents)
    return this.runtime
  }

  async show(): Promise<void> {
    if (this.alive && !this.window.isDestroyed()) this.window.show()
  }

  async waitForRuntimeReady(signal?: AbortSignal): Promise<void> {
    if (!this.options.isRuntimeReady) return
    while (this.alive && !this.window.isDestroyed()) {
      if (signal?.aborted) throw new Error('Runtime 等待已取消')
      if (await this.options.isRuntimeReady(this.context, this.window.webContents)) return
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const done = () => { cleanup(); resolve() }
        const timer = setTimeout(done, 100)
        const abort = () => { clearTimeout(timer); cleanup(); reject(new Error('Runtime 等待已取消')) }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error(`页面 ${this.id} 已关闭`)
  }

  async close(): Promise<void> {
    if (!this.window.isDestroyed()) this.window.close()
    try { await this.runtime?.dispose() } catch { /* renderer teardown */ }
    this.runtime = undefined
    this.alive = false
  }

  isAlive(): boolean { return this.alive && !this.window.isDestroyed() }
}
