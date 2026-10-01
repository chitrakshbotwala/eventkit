import { randomUUID } from 'node:crypto';
import { arch as osArch, hostname, release, version as osVersionFn } from 'node:os';
import { app } from 'electron';
import type { Arch, DeviceInfo, Platform } from '@eventkit/shared';
import { paths } from './config';
import { readJson, writeJson } from './store';

export function currentPlatform(): Platform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * Real hardware arch. An x64 build running under Rosetta / Windows-on-ARM
 * emulation reports x64 from process.arch, so ask the OS as well.
 */
export function currentArch(): Arch {
  if (process.platform === 'darwin' && app.runningUnderARM64Translation) return 'arm64';
  if (process.platform === 'win32' && app.runningUnderARM64Translation) return 'arm64';
  const a = process.arch === 'arm64' || osArch() === 'arm64' ? 'arm64' : 'x64';
  return a;
}

export function osVersion(): string {
  try {
    return `${osVersionFn()} (${release()})`.slice(0, 200);
  } catch {
    return release();
  }
}

export function clientDeviceId(): string {
  const file = paths.file('device.json');
  const data = readJson<{ clientDeviceId?: string }>(file, {});
  if (data.clientDeviceId) return data.clientDeviceId;
  const id = randomUUID();
  writeJson(file, { clientDeviceId: id });
  return id;
}

export function deviceInfo(): DeviceInfo {
  return {
    clientDeviceId: clientDeviceId(),
    os: currentPlatform(),
    arch: currentArch(),
    osVersion: osVersion(),
    hostname: hostname().slice(0, 200),
    appVersion: app.getVersion(),
  };
}
