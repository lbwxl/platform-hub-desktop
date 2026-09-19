import type { PlatformMessage } from './platform'

export function mergePlatformMessage(current: PlatformMessage, incoming: PlatformMessage): PlatformMessage {
  return {
    ...current,
    ...incoming,
    senderId: incoming.senderId || current.senderId,
    senderName: incoming.senderName || current.senderName,
    content: incoming.content || current.content,
    timestamp: incoming.timestamp || current.timestamp,
    avatar: incoming.avatar || current.avatar,
    order: incoming.order || current.order,
    product: incoming.product || current.product,
    raw: incoming.raw || current.raw,
  }
}

export function upsertPlatformMessage(messages: PlatformMessage[], incoming: PlatformMessage): PlatformMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id)
  const next = index < 0
    ? [...messages, incoming]
    : messages.map((message, currentIndex) => currentIndex === index ? mergePlatformMessage(message, incoming) : message)
  return next.sort((left, right) => left.timestamp - right.timestamp)
}
