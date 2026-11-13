import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchivedIds } from './archived-ids.js';

const line = (id: unknown): string => JSON.stringify({ id, text: 'hi' });
const tmp = (): string => mkdtempSync(join(tmpdir(), 'archived-ids-'));
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

describe('ArchivedIds', () => {
  it('reads ids from every day file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, '2026-11-12.jsonl'), `${line('a')}\n${line('b')}\n`);
    writeFileSync(join(dir, '2026-11-13.jsonl'), `${line('c')}\n`);
    const ids = await ArchivedIds.fromFolder(dir);
    for (const id of ['a', 'b', 'c']) expect(ids.has(id)).toBe(true);
    expect(ids.has('zzz')).toBe(false);
  });

  it('skips bad lines without throwing', async () => {
    const dir = tmp();
    const content = [line('ok1'), '', 'not json', JSON.stringify({ text: 'x' }), line(5), line('ok2')].join('\n');
    writeFileSync(join(dir, '2026-11-12.jsonl'), content);
    const ids = await ArchivedIds.fromFolder(dir);
    expect(ids.has('ok1')).toBe(true);
    expect(ids.has('ok2')).toBe(true);
    expect(ids.has('5')).toBe(false);
    expect(ids.has('')).toBe(false);
    expect(ids.has('not json')).toBe(false);
  });

  it('returns an empty set for a missing folder and does not create it', async () => {
    const dir = join(tmp(), 'missing');
    const ids = await ArchivedIds.fromFolder(dir);
    expect(ids.has('a')).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('ignores files that are not .jsonl', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'notes.txt'), `${line('n1')}\n`);
    writeFileSync(join(dir, 'messages.json'), `${line('n2')}\n`);
    const ids = await ArchivedIds.fromFolder(dir);
    expect(ids.has('n1')).toBe(false);
    expect(ids.has('n2')).toBe(false);
  });

  it('add remembers an id without touching files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, '2026-11-12.jsonl'), `${line('a')}\n`);
    const before = snapshot(dir);
    const ids = await ArchivedIds.fromFolder(dir);
    ids.add('m1');
    expect(ids.has('m1')).toBe(true);
    expect(snapshot(dir)).toEqual(before);
  });
});
