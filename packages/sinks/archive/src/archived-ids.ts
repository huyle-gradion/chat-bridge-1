/** Placeholder: every member throws until the archived-ids reader is built. */
export class ArchivedIds {
  public static fromFolder(_folder: string): Promise<ArchivedIds> {
    throw new Error('not implemented');
  }

  public has(_id: string): boolean {
    throw new Error('not implemented');
  }

  public add(_id: string): void {
    throw new Error('not implemented');
  }
}
