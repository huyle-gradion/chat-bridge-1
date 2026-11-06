import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { ChatPicker, Outbox, PolicyFilter, FeedStore } from '@chat-bridge/engine';

export interface CliSettings {
  schemaVersion: number;
  language: 'en' | 'vi';
  filters: {
    allowGroups: boolean;
    otpFilterEnabled: boolean;
    blockedContacts: string[];
    customBlockedPatterns: string[];
  };
  chats: {
    pickedChatIds: string[];
  };
  sinks: Record<
    string,
    {
      type: 'archive' | 'database' | 'sheet' | 'margince';
      enabled: boolean;
      config: Record<string, unknown>;
    }
  >;
}

export const DEFAULT_SETTINGS: CliSettings = {
  schemaVersion: 1,
  language: 'en',
  filters: {
    allowGroups: false,
    otpFilterEnabled: true,
    blockedContacts: [],
    customBlockedPatterns: [],
  },
  chats: {
    pickedChatIds: [],
  },
  sinks: {},
};

export class CliContext {
  public readonly dataDir: string;
  public readonly settingsPath: string;
  public readonly dbPath: string;
  public readonly outboxDbPath: string;
  public readonly keyPath: string;
  private dbInstance: Database.Database | null = null;
  private masterKey: Buffer | null = null;
  private cachedSettings: CliSettings | null = null;

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ??
      process.env['CHAT_BRIDGE_DATA_DIR'] ??
      path.join(os.homedir(), '.chat-bridge');

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.dbPath = path.join(this.dataDir, 'internal.db');
    this.outboxDbPath = path.join(this.dataDir, 'outbox.db');
    this.keyPath = path.join(this.dataDir, 'master.key');
  }

  public getSettings(): CliSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    if (fs.existsSync(this.settingsPath)) {
      try {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const loaded: CliSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          filters: { ...DEFAULT_SETTINGS.filters, ...(parsed.filters ?? {}) },
          chats: { ...DEFAULT_SETTINGS.chats, ...(parsed.chats ?? {}) },
          sinks: { ...DEFAULT_SETTINGS.sinks, ...(parsed.sinks ?? {}) },
        };
        this.cachedSettings = loaded;
        return loaded;
      } catch {
        // Fall back to default if parsing failed
      }
    }

    const newSettings: CliSettings = { ...DEFAULT_SETTINGS };
    this.cachedSettings = newSettings;
    this.saveSettings(newSettings);
    return newSettings;
  }

  public saveSettings(settings: CliSettings): void {
    this.cachedSettings = settings;
    const tempFile = path.join(
      this.dataDir,
      `settings.json.tmp.${process.pid}.${Date.now()}`
    );
    const backupFile = path.join(this.dataDir, 'settings.json.bak');

    fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), 'utf-8');

    if (fs.existsSync(this.settingsPath)) {
      try {
        fs.copyFileSync(this.settingsPath, backupFile);
      } catch {
        // Ignore backup copy failure
      }
    }

    fs.renameSync(tempFile, this.settingsPath);
  }

  public getMasterKey(): Buffer {
    if (this.masterKey) {
      return this.masterKey;
    }

    if (fs.existsSync(this.keyPath)) {
      this.masterKey = fs.readFileSync(this.keyPath);
      if (this.masterKey.length === 32) {
        return this.masterKey;
      }
    }

    // Generate new 32-byte key
    this.masterKey = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, this.masterKey, { mode: 0o600 });
    return this.masterKey;
  }

  public getDatabase(): Database.Database {
    if (this.dbInstance && this.dbInstance.open) {
      return this.dbInstance;
    }

    this.dbInstance = new Database(this.dbPath);
    this.dbInstance.pragma('journal_mode = WAL');
    this.dbInstance.pragma('synchronous = NORMAL');
    return this.dbInstance;
  }

  public getChatPicker(): ChatPicker {
    const db = this.getDatabase();
    const picker = new ChatPicker({ db });
    const settings = this.getSettings();

    for (const id of settings.chats.pickedChatIds) {
      picker.tickChat(id);
    }
    return picker;
  }

  public getPolicyFilter(): PolicyFilter {
    const settings = this.getSettings();
    return new PolicyFilter({
      allowGroups: settings.filters.allowGroups,
      otpFilterEnabled: settings.filters.otpFilterEnabled,
      blockedContacts: settings.filters.blockedContacts,
      customBlockedPatterns: settings.filters.customBlockedPatterns,
    });
  }

  public getOutbox(): Outbox {
    const masterKey = this.getMasterKey();
    return new Outbox({ dbPath: this.outboxDbPath, masterKey });
  }

  public getFeedStore(): FeedStore {
    const db = this.getDatabase();
    const masterKey = this.getMasterKey();
    return new FeedStore({ db, masterKey });
  }

  public close(): void {
    if (this.dbInstance && this.dbInstance.open) {
      this.dbInstance.close();
      this.dbInstance = null;
    }
  }
}
