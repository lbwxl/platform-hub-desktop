import assert from 'node:assert/strict'
import test from 'node:test'
import { OutboundCorrelationTracker } from '../packages/hook-sdk/dist/index.js'

test('OutboundCorrelationTracker matches and consumes platform-neutral fingerprints', () => {
  let now = 100
  const tracker = new OutboundCorrelationTracker({ ttlMs: 50, maxEntries: 2, now: () => now })
  const tracked = tracker.register({ conversationId: 'conversation-1', messageType: 'text', fingerprint: 'text:hello' })
  assert.equal(tracker.size, 1)
  assert.equal(tracker.match({ conversationId: 'other', messageType: 'text', fingerprint: 'text:hello' }), undefined)
  assert.equal(tracker.match({ conversationId: 'conversation-1', messageType: 'text', fingerprint: 'text:hello' })?.operationId, tracked.operationId)
  assert.equal(tracker.size, 0)

  tracker.register({ conversationId: 'conversation-1', messageType: 'text', fingerprint: 'expired' })
  now = 151
  assert.equal(tracker.size, 0)
})

test('OutboundCorrelationTracker bounds entries and lets failed sends be removed', () => {
  const tracker = new OutboundCorrelationTracker({ maxEntries: 2 })
  const failed = tracker.register({ conversationId: 'conversation-1', messageType: 'file', fingerprint: 'file:a' })
  assert.equal(tracker.remove(failed.operationId), true)
  tracker.register({ operationId: '1', conversationId: 'conversation-1', messageType: 'text', fingerprint: '1' })
  tracker.register({ operationId: '2', conversationId: 'conversation-1', messageType: 'text', fingerprint: '2' })
  tracker.register({ operationId: '3', conversationId: 'conversation-1', messageType: 'text', fingerprint: '3' })
  assert.equal(tracker.size, 2)
  assert.equal(tracker.match({ conversationId: 'conversation-1', messageType: 'text', fingerprint: '1' }), undefined)
})
