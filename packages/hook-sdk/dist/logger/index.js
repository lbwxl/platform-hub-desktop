export const noopHookLogger = {
    debug() { },
    info() { },
    warn() { },
    error() { },
};
export function withHookLoggerContext(logger, base) {
    const merge = (context) => ({ ...base, ...context });
    return {
        debug: (message, context) => logger.debug(message, merge(context)),
        info: (message, context) => logger.info(message, merge(context)),
        warn: (message, context) => logger.warn(message, merge(context)),
        error: (message, context) => logger.error(message, merge(context)),
    };
}
//# sourceMappingURL=index.js.map