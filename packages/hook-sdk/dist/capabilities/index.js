export const HOOK_CAPABILITIES = [
    'auth.state',
    'sessions.list',
    'messages.listen',
    'messages.history',
    'messages.send.text',
    'messages.send.file',
    'products.list',
    'products.detail',
    'orders.list',
    'orders.listen',
];
export const HOOK_OPERATION_PRIORITIES = {
    'auth.state': 'auth',
    'sessions.list': 'message',
    'messages.listen': 'message',
    'messages.history': 'message',
    'messages.send.text': 'message',
    'messages.send.file': 'message',
    'products.list': 'product',
    'products.detail': 'product',
    'orders.list': 'order',
    'orders.listen': 'order',
};
//# sourceMappingURL=index.js.map