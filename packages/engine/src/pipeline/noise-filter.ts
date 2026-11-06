import type { Message } from '@chat-bridge/types';

export type NoiseDropReason =
  | 'broadcast_story'
  | 'newsletter_channel'
  | 'reaction_event'
  | 'typing_event'
  | 'message_edit';

export interface NoiseFilterResult {
  drop: boolean;
  reason?: NoiseDropReason | undefined;
}

/**
 * Checks whether a message is non-conversational protocol noise or a social broadcast.
 * Per Spec Feature C-4 & ADR 0010:
 * Stories (status@broadcast), newsletters, reactions, edits, and typing events must never reach a sink.
 */
export function isNoiseMessage(message: Message): boolean {
  return dropNoiseFilter(message).drop;
}

export function dropNoiseFilter(message: Message): NoiseFilterResult {
  // 1. WhatsApp status broadcast stories
  if (
    message.thread === 'status@broadcast' ||
    message.from.accountId === 'status@broadcast' ||
    message.text === '[story broadcast update]'
  ) {
    return { drop: true, reason: 'broadcast_story' };
  }

  // 2. WhatsApp newsletter channels
  if (
    message.thread.endsWith('@newsletter') ||
    message.from.accountId.endsWith('@newsletter') ||
    message.text === '[newsletter broadcast]'
  ) {
    return { drop: true, reason: 'newsletter_channel' };
  }

  // 3. Reaction events
  if (
    message.text.startsWith('[reaction:') ||
    message.text === '[reaction]' ||
    message.text.startsWith('[event:reaction')
  ) {
    return { drop: true, reason: 'reaction_event' };
  }

  // 4. Typing indicators
  if (
    message.text === '[typing...]' ||
    message.text.startsWith('[typing') ||
    message.text.startsWith('[event:typing')
  ) {
    return { drop: true, reason: 'typing_event' };
  }

  // 5. Message edits and revokes
  if (
    message.text === '[message edited]' ||
    message.text === '[message deleted]' ||
    message.text.startsWith('[event:edit')
  ) {
    return { drop: true, reason: 'message_edit' };
  }

  return { drop: false };
}
