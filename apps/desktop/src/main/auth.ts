import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { shell } from 'electron';
import {
  MeResponseSchema,
  SignInResponseSchema,
  type AttendeeProfile,
  type SignInResponse,
} from '@eventkit/shared';
import type { AuthState } from '../common/ipc';
import { api, ApiError } from './api';
import { config, paths } from './config';
import { deviceInfo } from './device';
import { errMsg, logger } from './logger';
import { SignInError, startLoopback, type Loopback } from './loopback';
import { secureStore } from './secure-store';
import { readJson, writeJson } from './store';

const log = logger.scope('auth');

interface StoredProfile {
  profile: AttendeeProfile | null;
  deviceId: string | null;
}

/** Attendee session: token + device key in safeStorage, profile cached for offline use. */
class Auth extends EventEmitter {
  private stored = readJson<StoredProfile>(paths.file('profile.json'), {
    profile: null,
    deviceId: null,
  });
  private lastError: string | undefined;
  private pending: { loop: Loopback; url: string } | null = null;

  state(): AuthState {
    const signedIn = Boolean(secureStore.get('sessionToken')) && Boolean(this.stored.profile);
    return { signedIn, profile: signedIn ? this.stored.profile : null, error: this.lastError };
  }

  get profile() {
    return this.stored.profile;
  }

  get deviceKey(): Buffer | null {
    const k = secureStore.get('deviceKey');
    return k ? Buffer.from(k, 'base64') : null;
  }

  private save(profile: AttendeeProfile | null, deviceId: string | null = this.stored.deviceId) {
    this.stored = { profile, deviceId };
    writeJson(paths.file('profile.json'), this.stored);
    this.emit('changed', this.state());
  }

  /**
   * "Sign in with Google" in the system browser (OAuth for native apps, RFC 8252):
   * a one-shot loopback listener receives a one-time code from the event server, which
   * is redeemed together with a PKCE verifier that never leaves this process.
   */
  async signInWithGoogle(): Promise<AuthState> {
    this.cancelSignIn();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const loop = await startLoopback(state);
    const url = `${config.apiBaseUrl}/auth/google/start?${new URLSearchParams({
      port: String(loop.port),
      challenge,
      state,
    }).toString()}`;
    this.pending = { loop, url };
    try {
      await shell.openExternal(url);
      const r = await loop.result;
      if ('error' in r) throw new SignInError(r.error, r.message);
      const res = await api.request('/auth/google/exchange', SignInResponseSchema, {
        body: { code: r.code, verifier, device: deviceInfo() },
      });
      return this.completeSignIn(res);
    } finally {
      loop.close();
      if (this.pending?.loop === loop) this.pending = null;
    }
  }

  /** Abort a sign-in that is waiting for the browser. */
  cancelSignIn() {
    this.pending?.loop.close();
    this.pending = null;
  }

  /** Re-open the browser for a sign-in that is still waiting (tab closed by mistake). */
  async reopenSignIn() {
    if (this.pending) await shell.openExternal(this.pending.url);
  }

  private completeSignIn(res: SignInResponse): AuthState {
    secureStore.set('sessionToken', res.token);
    secureStore.set('deviceKey', res.deviceKey);
    api.setOffset(res.serverTime - Date.now());
    this.lastError = undefined;
    log.info(`signed in as attendee ${res.attendee.id}`);
    this.save(res.attendee, res.deviceId);
    return this.state();
  }

  /** Refresh profile from the server; keeps the cached profile when offline. */
  async refresh(): Promise<AuthState> {
    if (!secureStore.get('sessionToken')) return this.state();
    try {
      const me = await api.request('/api/me', MeResponseSchema, { auth: true });
      api.setOffset(me.serverTime - Date.now());
      const changed = JSON.stringify(me.attendee) !== JSON.stringify(this.stored.profile);
      this.lastError = undefined;
      if (changed) this.save(me.attendee);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        log.warn('session rejected by server; signing out');
        this.lastError = 'Your session expired. Please sign in again.';
        this.clear();
      } else {
        log.debug(`profile refresh failed: ${errMsg(err)}`);
      }
    }
    return this.state();
  }

  /** Update cached profile fields (e.g. after readiness is accepted). */
  patchProfile(patch: Partial<AttendeeProfile>) {
    if (!this.stored.profile) return;
    this.save({ ...this.stored.profile, ...patch });
  }

  async signOut() {
    try {
      await api.request('/auth/logout', null, { method: 'POST', auth: true, timeoutMs: 5_000 });
    } catch {
      // offline sign-out still clears local credentials
    }
    this.clear();
  }

  private clear() {
    secureStore.delete('sessionToken', 'deviceKey', 'qrSecret');
    this.save(null, null);
  }
}

export const auth = new Auth();
