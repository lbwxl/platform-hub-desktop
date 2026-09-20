export interface HookLogContext extends Record<string, unknown> {
    platformId?: string;
    shopId?: string;
    sessionId?: string;
    conversationId?: string;
    operation?: string;
    requestId?: string;
}
export interface HookLogger {
    debug(message: string, context?: HookLogContext): void;
    info(message: string, context?: HookLogContext): void;
    warn(message: string, context?: HookLogContext): void;
    error(message: string, context?: HookLogContext): void;
}
export declare const noopHookLogger: HookLogger;
export declare function withHookLoggerContext(logger: HookLogger, base: HookLogContext): HookLogger;
//# sourceMappingURL=index.d.ts.map