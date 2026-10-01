import { safeStorage } from 'electron';
import { paths } from './config';
import { logger } from './logger';
import { readJson, writeJson } from './store';

const log = logger.scope('secure-store');

export type SecretKey = 'sessionToken' | 'deviceKey' | 'qrSecret';

/**
 * Secrets encrypted with Electron safeStorage (DPAPI on Windows, Keychain on
 * macOS, libsecret/kwallet on Linux). Stored as base64 ciphertext in userData.
 */
class SecureStore {
  private cache = new Map<SecretKey, string>();
  private warned = false;

  private get file() {
    return paths.file('secure.json');
  }

  private check() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable; cannot store credentials safely');
    }
    if (process.platform === 'linux' && !this.warned) {
      this.warned = true;
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text')
        log.warn('no OS keyring found: secrets use weak basic_text encryption');
    }
  }

  get(key: SecretKey): string | null {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    const enc = data[key];
    if (!enc) return null;
    try {
      this.check();
      const value = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      this.cache.set(key, value);
      return value;
    } catch (err) {
      log.error(`failed to decrypt ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  set(key: SecretKey, value: string) {
    this.check();
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    data[key] = safeStorage.encryptString(value).toString('base64');
    writeJson(this.file, data);
    this.cache.set(key, value);
  }

  delete(...keys: SecretKey[]) {
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    for (const k of keys) {
      delete data[k];
      this.cache.delete(k);
    }
    writeJson(this.file, data);
  }
}

export const secureStore = new SecureStore();
