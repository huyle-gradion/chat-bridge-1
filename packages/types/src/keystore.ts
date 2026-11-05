/**
 * OS-native or file-backed secure key-value store for cryptographic master keys.
 * ADR 0023: Keytar/OS Keychain integration with file-backed fallback.
 */
export interface KeyStore {
  /** Retrieves a stored secret by service key */
  getSecret(key: string): Promise<string | null>;

  /** Securely persists a secret string */
  setSecret(key: string, value: string): Promise<void>;

  /** Removes a secret string from the secure store */
  deleteSecret(key: string): Promise<boolean>;

  /** Checks if a secret exists without decrypting */
  hasSecret(key: string): Promise<boolean>;
}

