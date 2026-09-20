export interface HookLogContext extends Record<string, unknown> {
  platformId?: string
  shopId?: string
  sessionId?: string
  conversationId?: string
  operation?: string
  requestId?: string
}

export interface HookLogger {
  debug(message: string, context?: HookLogContext): void
  info(message: string, context?: HookLogContext): void
  warn(message: string, context?: HookLogContext): void
  error(message: string, context?: HookLogContext): void
}

export const noopHookLogger: HookLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export function withHookLoggerContext(logger: HookLogger, base: HookLogContext): HookLogger {
  const merge = (context?: HookLogContext): HookLogContext => ({ ...base, ...context })
  return {
    debug: (message, context) => logger.debug(message, merge(context)),
    info: (message, context) => logger.info(message, merge(context)),
    warn: (message, context) => logger.warn(message, merge(context)),
    error: (message, context) => logger.error(message, merge(context)),
  }
}
