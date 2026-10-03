import { app, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { paths } from './config';
import { logger } from './logger';
import { readJson, writeJson } from './store';

const log = logger.scope('secure-store');

export type SecretKey = 'sessionToken' | 'deviceKey' | 'qrSecret';

/** Marks values encrypted with our own file key (no OS keyring) rather than safeStorage. */
const FILE_KEY_PREFIX = 'k1:';

/** Whether a Secret Service (gnome-keyring, KeePassXC, ...) is running on the session bus. */
function secretServiceRunning(): boolean {
  try {
    const out = execFileSync(
      'dbus-send',
      [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        'string:org.freedesktop.secrets',
      ],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return /boolean true/.test(out);
  } catch {
    return false;
  }
}

/**
 * Chromium only uses the system keyring by itself on desktops it recognises (GNOME, KDE,
 * XFCE, Cinnamon, ...). On window managers such as Hyprland (Omarchy), sway or i3 it
 * would not, so ask for the Secret Service when one is running. KDE keeps KWallet.
 * Must run before the app is ready.
 */
export function preferOsKeyringOnLinux() {
  if (process.platform !== 'linux' || app.commandLine.hasSwitch('password-store')) return;
  const desktop = `${process.env['XDG_CURRENT_DESKTOP'] ?? ''}:${process.env['DESKTOP_SESSION'] ?? ''}`;
  if (/kde|plasma/i.test(desktop)) return;
  if (secretServiceRunning()) app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

/**
 * Secrets encrypted with Electron safeStorage: DPAPI on Windows, Keychain on macOS, and
 * the Secret Service or KWallet on Linux. Stored as base64 ciphertext in userData.
 *
 * A Linux session with no keyring service at all would otherwise block sign-in. There
 * the secrets are encrypted with AES-256-GCM under a random key kept in a file only the
 * user can read (0600), which is what Chromium's own fallback amounts to, minus its
 * hard-coded key. A keyring adds protection against other local users and offline disk
 * access, not against the attendee, who owns these secrets anyway.
 */
class SecureStore {
  private cache = new Map<SecretKey, string>();
  private mode: 'os' | 'file-key' | null = null;
  private fileKey: Buffer | null = null;

  private get file() {
    return paths.file('secure.json');
  }

  /** How new secrets are protected; decided once, after the app is ready. */
  private resolveMode(): 'os' | 'file-key' {
    if (this.mode) return this.mode;
    // Encryption is never available before ready; don't mistake that for "no keyring".
    if (!app.isReady()) throw new Error('secure storage used before the app is ready');
    const backend =
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os keychain';
    if (safeStorage.isEncryptionAvailable() && backend !== 'basic_text') {
      log.info(`secrets are stored with ${backend}`);
      return (this.mode = 'os');
    }
    if (process.platform !== 'linux') {
      throw new Error('OS secure storage is unavailable; cannot store credentials safely');
    }
    log.warn(
      'no OS keyring (Secret Service or KWallet) found: secrets are protected by file permissions only',
    );
    return (this.mode = 'file-key');
  }

  private key(): Buffer {
    if (this.fileKey) return this.fileKey;
    const file = paths.file('secret.key');
    let key: Buffer | null = null;
    try {
      key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    } catch {
      // created below
    }
    if (key?.length !== 32) {
      key = randomBytes(32);
      writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    }
    return (this.fileKey = key);
  }

  private encrypt(value: string): string {
    if (this.resolveMode() === 'os') return safeStorage.encryptString(value).toString('base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return FILE_KEY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private decrypt(stored: string): string {
    if (stored.startsWith(FILE_KEY_PREFIX)) {
      const raw = Buffer.from(stored.slice(FILE_KEY_PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
    if (!app.isReady()) throw new Error('secure storage used before the app is ready');
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  }

  /** Encrypt and decrypt a throwaway value; returns how secrets are protected. */
  selfTest(): string {
    const probe = `probe-${Date.now()}`;
    if (this.decrypt(this.encrypt(probe)) !== probe) {
      throw new Error('secure storage round trip returned a different value');
    }
    if (this.mode === 'file-key') return 'file-key';
    return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
  }

  get(key: SecretKey): string | null {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    const enc = data[key];
    if (!enc) return null;
    try {
      const value = this.decrypt(enc);
      this.cache.set(key, value);
      return value;
    } catch (err) {
      log.error(`failed to decrypt ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  set(key: SecretKey, value: string) {
    const data = readJson<Partial<Record<SecretKey, string>>>(this.file, {});
    data[key] = this.encrypt(value);
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
