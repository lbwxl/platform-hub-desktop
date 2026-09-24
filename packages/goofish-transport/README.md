# Goofish Transport

`GoofishTransport` adapts the existing Electron `GoofishMessagingClient` to the shared Hook Transport / Hook SDK contract. It does not create a second page, own Electron partitions, reimplement the official messaging bridge, or implement PageHookRuntime.

Each instance has one immutable Platform Hub `accountId` and one Goofish client account key. Multiple instances may share a `GoofishMessagingClient`. When the client migrates its temporary key to the official seller ID, the transport follows the migration while the client preserves the account partition.

Supported operations:

- `auth.state`
- `sessions.list`
- `messages.listen`
- `messages.history`
- `messages.send.text`
- `messages.send.file` (image MIME types only)
- `products.list`
- `products.detail`

Message origin uses only available evidence: Hook sends are `automation`; buyer inbound messages are `customer`; explicitly marked manual outbound messages are `human`; system notices are `system`; ambiguous outbound messages remain `unknown`. Listening starts at a watermark and does not replay history.

The transport does not declare orders, official handoff, or native conversation attention. Those operations return `NOT_SUPPORTED` rather than pretending to succeed. Product pagination, official API capture, login recovery, and product detail enrichment remain owned by `packages/goofish-messaging`.

Run the contract and multi-account integration tests with:

```sh
pnpm --dir packages/goofish-transport typecheck
node --experimental-strip-types --test tests/goofish-transport.test.mjs
```
