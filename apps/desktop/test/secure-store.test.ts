import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', available: false, backend: 'basic_text' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: () => true,
    getPath: () => h.dir,
    commandLine: { hasSwitch: () => false, appendSwitch: () => undefined },
  },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => h.backend,
    encryptString: (s: string) => Buffer.from(`os:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(3),
  },
}));

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p });
}

/** A fresh store, as after an app restart. */
async function freshStore() {
  vi.resetModules();
  return (await import('../src/main/secure-store')).secureStore;
}

const stored = () => JSON.parse(readFileSync(join(h.dir, 'secure.json'), 'utf8'));

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'ek-secure-'));
  h.available = false;
  h.backend = 'basic_text';
  setPlatform('linux');
});

afterEach(() => setPlatform(realPlatform));

describe('secure store', () => {
  it('works on a Linux desktop without a keyring (Hyprland, sway, i3)', async () => {
    const store = await freshStore();
    expect(store.selfTest()).toBe('file-key');
    store.set('sessionToken', 'tok-123');
    expect(stored().sessionToken).toMatch(/^k1:/);
    expect(stored().sessionToken).not.toContain('tok-123');
    expect((await freshStore()).get('sessionToken')).toBe('tok-123');
    if (realPlatform !== 'win32') {
      expect(statSync(join(h.dir, 'secret.key')).mode & 0o777).toBe(0o600);
      expect(statSync(join(h.dir, 'secure.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('uses the OS keyring when there is one', async () => {
    h.available = true;
    h.backend = 'gnome_libsecret';
    const store = await freshStore();
    expect(store.selfTest()).toBe('gnome_libsecret');
    store.set('deviceKey', 'dk');
    expect(stored().deviceKey).toBe(Buffer.from('os:dk').toString('base64'));
    expect((await freshStore()).get('deviceKey')).toBe('dk');
  });

  it('still reads secrets saved before a keyring was set up', async () => {
    (await freshStore()).set('qrSecret', 'qr');
    h.available = true;
    h.backend = 'gnome_libsecret';
    expect((await freshStore()).get('qrSecret')).toBe('qr');
  });

  it('refuses on Windows and macOS when the OS store is unavailable', async () => {
    setPlatform('win32');
    const store = await freshStore();
    expect(() => store.set('sessionToken', 'x')).toThrow(/secure storage is unavailable/);
  });
});
