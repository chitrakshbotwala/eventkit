import { app, safeStorage } from 'electron';
import { paths } from './config';
import { logger } from './logger';
import { readJson, writeJson } from './store';

const log = logger.scope('secure-store');

export type SecretKey = 'sessionToken' | 'deviceKey' | 'qrSecret';

/**
 * Chromium only picks the system keyring itself on desktops it recognises (GNOME, KDE,
 * XFCE, Cinnamon, …). On window managers such as Hyprland (Omarchy), sway or i3 it
 * would use its weak built-in key, so ask for the Secret Service (gnome-keyring,
 * KeePassXC, …) explicitly. KDE keeps KWallet. Must run before the app is ready.
 */
export function preferOsKeyringOnLinux() {
  if (process.platform !== 'linux' || app.commandLine.hasSwitch('password-store')) return;
  const desktop = `${process.env['XDG_CURRENT_DESKTOP'] ?? ''}:${process.env['DESKTOP_SESSION'] ?? ''}`;
  if (/kde|plasma/i.test(desktop)) return;
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

/**
 * Secrets encrypted with Electron safeStorage (DPAPI on Windows, Keychain on macOS, the
 * Secret Service or KWallet on Linux), stored as base64 ciphertext in userData.
 *
 * A Linux session with no keyring service at all gets Electron's built-in key rather
 * than a refusal that would block sign-in: secure.json is then protected by its 0600
 * permissions only. A keyring would add protection against other local users and
 * offline disk access, not against the attendee, who owns these secrets anyway.
 */
class SecureStore {
  private cache = new Map<SecretKey, string>();
  private checked = false;

  private get file() {
    return paths.file('secure.json');
  }

  private check() {
    if (this.checked) return;
    // Encryption is never available before ready; don't mistake that for "no keyring".
    if (!app.isReady()) throw new Error('secure storage used before the app is ready');
    if (!safeStorage.isEncryptionAvailable() && process.platform === 'linux') {
      safeStorage.setUsePlainTextEncryption(true);
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable; cannot store credentials safely');
    }
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text') {
        log.warn(
          'no OS keyring (Secret Service or KWallet) found: secrets are protected by file permissions only',
        );
      } else log.info(`secrets are stored with ${backend}`);
    }
    this.checked = true;
  }

  /** Encrypt and decrypt a throwaway value; returns the storage backend in use. */
  selfTest(): string {
    this.check();
    const probe = `probe-${Date.now()}`;
    if (safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe) {
      throw new Error('secure storage round trip returned a different value');
    }
    return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
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
    writeJson(this.file, data, { mode: 0o600 });
    this.cache.set(key, value);
  }

  delete(...keys: SecretKey[]) {
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    for (const k of keys) {
      delete data[k];
      this.cache.delete(k);
    }
    writeJson(this.file, data, { mode: 0o600 });
  }
}

export const secureStore = new SecureStore();
