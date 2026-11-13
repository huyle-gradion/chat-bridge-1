import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The message ids already stored in an archive folder's `.jsonl` day files. */
export class ArchivedIds {
  private constructor(private readonly ids: Set<string>) {}

  public static async fromFolder(folder: string): Promise<ArchivedIds> {
    const ids = new Set<string>();
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return new ArchivedIds(ids);
    }
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      let content: string;
      try {
        content = await readFile(join(folder, name), 'utf8');
      } catch {
        continue;
      }
      for (const text of content.split('\n')) {
        if (text.trim() === '') continue;
        try {
          const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
          if (typeof id === 'string') ids.add(id);
        } catch {
          // skip malformed line
        }
      }
    }
    return new ArchivedIds(ids);
  }

  public has(id: string): boolean {
    return this.ids.has(id);
  }

  public add(id: string): void {
    this.ids.add(id);
  }
}
