import { EventEmitter } from 'node:events';
import {
  MeResponseSchema,
  RequestOtpResponseSchema,
  VerifyOtpResponseSchema,
  type AttendeeProfile,
} from '@eventkit/shared';
import type { AuthState } from '../common/ipc';
import { api, ApiError } from './api';
import { paths } from './config';
import { deviceInfo } from './device';
import { errMsg, logger } from './logger';
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

  async requestOtp(email: string) {
    const res = await api.request('/auth/request-otp', RequestOtpResponseSchema, {
      body: { email },
    });
    return { message: res.message };
  }

  async verifyOtp(email: string, code: string): Promise<AuthState> {
    const res = await api.request('/auth/verify-otp', VerifyOtpResponseSchema, {
      body: { email, code, device: deviceInfo() },
    });
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
