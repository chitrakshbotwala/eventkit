import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@eventkit/shared';
import { verifyChain } from '@eventkit/shared/node';
import { LocalLog } from '../src/main/phase2/eventlog';
import {
  activeInterfaces,
  isPrivateHost,
  probeReachability,
  type Probe,
} from '../src/main/phase2/netprobe';
import { inEnforcedWindow, isMonitoring, phaseState } from '../src/main/phase2/state';

const T = Date.UTC(2026, 9, 10, 10, 0, 0);
const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's',
  version: 1,
  startAt: new Date(T).toISOString(),
  endAt: new Date(T + 3600_000).toISOString(),
  timezone: 'UTC',
  mode: 'strict',
  graceSeconds: 120,
  heartbeatSeconds: 60,
  preSyncMinutes: 5,
  updatedAt: new Date(T).toISOString(),
  ...over,
});

describe('phase state', () => {
  it('walks scheduled -> presync -> active -> ended', () => {
    expect(phaseState(null, T)).toBe('none');
    expect(phaseState(sched({ startAt: null }), T)).toBe('none');
    expect(phaseState(sched(), T - 10 * 60_000)).toBe('scheduled');
    expect(phaseState(sched(), T - 4 * 60_000)).toBe('presync');
    expect(phaseState(sched(), T)).toBe('active');
    expect(phaseState(sched(), T + 3600_000)).toBe('ended');
    expect(isMonitoring('presync') && isMonitoring('active') && !isMonitoring('ended')).toBe(true);
  });

  it('applies the grace period', () => {
    expect(inEnforcedWindow(sched(), T + 60_000)).toBe(false);
    expect(inEnforcedWindow(sched(), T + 121_000)).toBe(true);
    expect(inEnforcedWindow(sched(), T + 3600_000)).toBe(false);
  });
});

describe('interfaces', () => {
  const addr = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  });

  it('ignores loopback, link-local, virtual and VPN adapters', () => {
    const ifaces = {
      lo: [addr('127.0.0.1', 'IPv4', true)],
      'Wi-Fi': [addr('192.168.1.23', 'IPv4')],
      'vEthernet (WSL)': [addr('172.25.192.1', 'IPv4')],
      Ethernet: [addr('169.254.10.2', 'IPv4'), addr('fe80::1', 'IPv6')],
      docker0: [addr('172.17.0.1', 'IPv4')],
      CloudflareWARP: [addr('172.16.0.2', 'IPv4')],
      'OpenVPN Wintun': [addr('10.8.0.2', 'IPv4')],
      en0: [addr('2001:db8::5', 'IPv6')],
    } as unknown as Parameters<typeof activeInterfaces>[0];
    expect(activeInterfaces(ifaces)).toEqual(['Wi-Fi', 'en0']);
  });

  it('knows private hosts do not prove internet access', () => {
    for (const h of [
      'localhost',
      '10.0.0.5',
      '192.168.0.2',
      '172.20.1.1',
      '[::1]',
      'fd12::1',
      'server.lan',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ['event.example.org', '8.8.8.8', '172.32.0.1'])
      expect(isPrivateHost(h)).toBe(false);
  });
});

describe('reachability probes', () => {
  const down: Probe = { target: 'tcp', ok: false };
  const fetchFrom = (answers: Record<string, number | 'fail'>) => async (url: string) => {
    const hit = Object.entries(answers).find(([k]) => url.startsWith(k));
    if (!hit || hit[1] === 'fail') throw new Error('offline');
    return new Response(null, { status: hit[1] });
  };

  it('offline: nothing answers', async () => {
    const r = await probeReachability({
      fetch: fetchFrom({}),
      serverUrl: 'https://event.example.org',
      tcp: async () => down,
    });
    expect(r).toMatchObject({ internet: false, serverReachable: false, captive: false });
  });

  it('online: any public endpoint answering is enough', async () => {
    const r = await probeReachability({
      fetch: fetchFrom({ 'https://connectivitycheck.gstatic.com': 204 }),
      serverUrl: 'https://event.example.org',
      tcp: async () => down,
    });
    expect(r.internet).toBe(true);
  });

  it('treats a captive portal as online', async () => {
    const r = await probeReachability({
      fetch: fetchFrom({ 'http://connectivitycheck.gstatic.com': 302 }),
      serverUrl: 'https://event.example.org',
      tcp: async () => down,
    });
    expect(r).toMatchObject({ internet: true, captive: true });
  });

  it('a raw TCP handshake to a public IP counts as online', async () => {
    const r = await probeReachability({
      fetch: fetchFrom({}),
      serverUrl: 'https://event.example.org',
      tcp: async (host) => ({ target: host, ok: host === '8.8.8.8' }),
    });
    expect(r.internet).toBe(true);
  });

  it('a LAN event server alone is not internet, a public one is', async () => {
    const lan = await probeReachability({
      fetch: fetchFrom({ 'http://10.0.0.5': 200 }),
      serverUrl: 'http://10.0.0.5:8080',
      tcp: async () => down,
    });
    expect(lan).toMatchObject({ internet: false, serverReachable: true });
    const pub = await probeReachability({
      fetch: fetchFrom({ 'https://event.example.org': 200 }),
      serverUrl: 'https://event.example.org',
      tcp: async () => down,
    });
    expect(pub.internet).toBe(true);
  });
});

describe('LocalLog', () => {
  const key = Buffer.alloc(32, 4);

  it('writes a verifiable hash chain and tracks delivery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-log-'));
    const log = new LocalLog(
      dir,
      () => key,
      () => 1500,
    );
    expect(log.open(3)).toBe(true);
    expect(log.open(3)).toBe(false);
    log.append('app_start', { state: 'online' });
    log.append('offline', { interfaces: ['Wi-Fi'] });
    log.append('heartbeat', { state: 'offline' });
    const entries = log.entries();
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(entries.every((e) => e.offsetMs === 1500)).toBe(true);
    expect(verifyChain(entries, key).valid).toBe(true);

    expect(log.unsent()).toHaveLength(3);
    log.markSent(1);
    expect(log.unsent().map((e) => e.seq)).toEqual([2]);
    expect(log.pendingUpload).toBe(3);
    log.markUploaded(2);
    expect(log.pendingUpload).toBe(0);
    log.close();
    expect(log.finished).toBe(true);
    expect(log.append('heartbeat')).toBeNull();
  });

  it('survives restarts and a torn last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-log-'));
    const a = new LocalLog(
      dir,
      () => key,
      () => 0,
    );
    a.open(1);
    a.append('app_start');
    a.append('heartbeat');
    const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
    appendFileSync(join(dir, file), '{"logId":"trunc');
    const b = new LocalLog(
      dir,
      () => key,
      () => 0,
    );
    expect(b.isOpen).toBe(true);
    b.append('app_start');
    const entries = b.entries();
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(verifyChain(entries, key).valid).toBe(true);
  });

  it('does nothing without a device key (signed out)', () => {
    const log = new LocalLog(
      mkdtempSync(join(tmpdir(), 'ek-log-')),
      () => null,
      () => 0,
    );
    log.open(1);
    expect(log.append('heartbeat')).toBeNull();
  });
});
