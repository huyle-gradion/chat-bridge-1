import { describe, expect, it } from 'vitest';
import type { Message } from '@chat-bridge/types';
import { dayFileName, messageLine } from './day-file.js';

describe('dayFileName', () => {
  it('names files by UTC day', () => {
    expect(dayFileName('2026-11-12T23:59:59Z')).toBe('2026-11-12.jsonl');
    expect(dayFileName('2026-11-13T00:00:00Z')).toBe('2026-11-13.jsonl');
  });

  it('converts an offset time to the UTC day', () => {
    expect(dayFileName('2026-11-13T01:30:00+07:00')).toBe('2026-11-12.jsonl');
  });

  it('accepts milliseconds', () => {
    expect(dayFileName('2026-11-13T00:00:00.123Z')).toBe('2026-11-13.jsonl');
  });

  it('returns undefined for an invalid time without throwing', () => {
    expect(() => dayFileName('not-a-date')).not.toThrow();
    expect(dayFileName('not-a-date')).toBeUndefined();
    expect(() => dayFileName('')).not.toThrow();
    expect(dayFileName('')).toBeUndefined();
  });
});

describe('messageLine', () => {
  it('writes one line ending in a single newline', () => {
    const message = {
      id: 'whatsapp:a:1',
      time: '2026-11-13T00:00:00Z',
      text: 'first\nsecond',
    } as unknown as Message;
    const line = messageLine(message);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(message);
  });
});
