import { describe, it, expect } from 'vitest';
import { ScenarioBuilder } from '@chat-bridge/testing';
import type { Message } from '@chat-bridge/types';
import { isNoiseMessage, dropNoiseFilter } from './noise-filter.js';

describe('US-C4-01: Protocol Event & Non-Message Noise Dropping', () => {
  it('identifies WhatsApp status broadcast stories as noise', () => {
    const broadcastMsg: Message = {
      id: 'whatsapp:rep-01:broadcast-1',
      network: 'whatsapp',
      account: 'rep-01',
      thread: 'status@broadcast',
      threadKind: 'dm',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: 'status@broadcast', displayName: 'Status Broadcast' },
      to: [],
      text: 'Story update',
    };

    expect(isNoiseMessage(broadcastMsg)).toBe(true);
    const result = dropNoiseFilter(broadcastMsg);
    expect(result.drop).toBe(true);
    expect(result.reason).toBe('broadcast_story');
  });

  it('identifies WhatsApp newsletter channels as noise', () => {
    const newsletterMsg: Message = {
      id: 'whatsapp:rep-01:news-1',
      network: 'whatsapp',
      account: 'rep-01',
      thread: '123456789@newsletter',
      threadKind: 'group',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: '123456789@newsletter', displayName: 'Newsletter Channel' },
      to: [],
      text: 'Weekly summary issue #42',
    };

    expect(isNoiseMessage(newsletterMsg)).toBe(true);
    const result = dropNoiseFilter(newsletterMsg);
    expect(result.drop).toBe(true);
    expect(result.reason).toBe('newsletter_channel');
  });

  it('identifies emoji reaction events as noise', () => {
    const reactionMsg: Message = {
      id: 'fake:rep-01:react-1',
      network: 'fake',
      account: 'rep-01',
      thread: 'chat-1',
      threadKind: 'dm',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: 'c1', displayName: 'Customer' },
      to: [],
      text: '[reaction:heart]',
    };

    expect(isNoiseMessage(reactionMsg)).toBe(true);
    const result = dropNoiseFilter(reactionMsg);
    expect(result.drop).toBe(true);
    expect(result.reason).toBe('reaction_event');
  });

  it('identifies typing indicators as noise', () => {
    const typingMsg: Message = {
      id: 'fake:rep-01:type-1',
      network: 'fake',
      account: 'rep-01',
      thread: 'chat-1',
      threadKind: 'dm',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: 'c1', displayName: 'Customer' },
      to: [],
      text: '[typing...]',
    };

    expect(isNoiseMessage(typingMsg)).toBe(true);
    const result = dropNoiseFilter(typingMsg);
    expect(result.drop).toBe(true);
    expect(result.reason).toBe('typing_event');
  });

  it('identifies message edits as noise', () => {
    const editMsg: Message = {
      id: 'fake:rep-01:edit-1',
      network: 'fake',
      account: 'rep-01',
      thread: 'chat-1',
      threadKind: 'dm',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: 'c1', displayName: 'Customer' },
      to: [],
      text: '[message edited]',
    };

    expect(isNoiseMessage(editMsg)).toBe(true);
    const result = dropNoiseFilter(editMsg);
    expect(result.drop).toBe(true);
    expect(result.reason).toBe('message_edit');
  });

  it('allows normal customer messages to pass without dropping', () => {
    const normalMsg: Message = {
      id: 'fake:rep-01:norm-1',
      network: 'fake',
      account: 'rep-01',
      thread: 'chat-1',
      threadKind: 'dm',
      direction: 'inbound',
      time: new Date().toISOString(),
      from: { accountId: 'c1', displayName: 'Customer' },
      to: [],
      text: 'Can you send the quote for the project?',
    };

    expect(isNoiseMessage(normalMsg)).toBe(false);
    const result = dropNoiseFilter(normalMsg);
    expect(result.drop).toBe(false);
  });

  it('filters all synthetic noise from ScenarioBuilder correctly', () => {
    const scenario = new ScenarioBuilder({ seed: 77 })
      .withContacts(2)
      .withNoise(['reaction', 'typing', 'story', 'newsletter', 'edit'])
      .buildScenario();

    const noiseDropped = scenario.messages.filter((m) => isNoiseMessage(m));
    expect(noiseDropped.length).toBe(scenario.expectedNoiseMessageIds.length);

    for (const msg of noiseDropped) {
      expect(scenario.expectedNoiseMessageIds).toContain(msg.id);
    }
  });
});
