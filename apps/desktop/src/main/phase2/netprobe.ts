import { Socket } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Virtual/loopback adapters that do not mean "connected to a network". */
const VIRTUAL =
  /^(lo\d*|docker|br-|veth|virbr|vmnet|vboxnet|zt|utun|awdl|llw|anpi|bridge|gif|stf|ap\d|tun|tap|wg)|vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL|Npcap|Teredo|isatap|Bluetooth Network|Tailscale|ZeroTier|WARP|Cloudflare|OpenVPN|WireGuard|NordLynx|TAP-Windows|Wintun/i;

function usableAddress(a: NetworkInterfaceInfo): boolean {
  if (a.internal) return false;
  if (a.family === 'IPv4') return !a.address.startsWith('169.254.');
  return !/^fe80:/i.test(a.address);
}

/** Names of physical-looking interfaces that currently hold a usable address. */
export function activeInterfaces(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || VIRTUAL.test(name)) continue;
    if (addrs.some(usableAddress)) out.push(name);
  }
  return out.sort();
}

/** True for loopback/private/link-local hosts (a LAN server does not prove internet access). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal'))
    return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // CGNAT
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

export interface Probe {
  target: string;
  ok: boolean;
  status?: number;
  ms?: number;
  captive?: boolean;
}

export interface ProbeDeps {
  fetch: (
    url: string,
    init: { method: string; redirect: 'manual'; signal: AbortSignal; cache: 'no-store' },
  ) => Promise<Response>;
  serverUrl: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  tcp?: (host: string, port: number, timeoutMs: number) => Promise<Probe>;
}

async function httpProbe(deps: ProbeDeps, url: string, expect204 = false): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await deps.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3000),
    });
    await res.body?.cancel().catch(() => undefined);
    // ANY HTTP answer means packets reached a network beyond this laptop (captive portals included).
    return {
      target: url,
      ok: true,
      status: res.status,
      ms: Date.now() - t0,
      captive: expect204 ? res.status !== 204 : undefined,
    };
  } catch {
    return { target: url, ok: false, ms: Date.now() - t0 };
  }
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<Probe> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (ok: boolean) => {
      s.destroy();
      resolve({ target: `tcp://${host}:${port}`, ok, ms: Date.now() - t0 });
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

export interface ProbeResult {
  internet: boolean;
  serverReachable: boolean;
  captive: boolean;
  probes: Probe[];
}

/**
 * Real reachability: several independent endpoints over HTTPS/HTTP plus raw
 * TCP handshakes. Our own server only counts as "internet" when it is not on
 * a private/LAN address.
 */
export async function probeReachability(deps: ProbeDeps): Promise<ProbeResult> {
  const timeout = deps.timeoutMs ?? 3000;
  const serverProbeUrl = `${deps.serverUrl.replace(/\/+$/, '')}/api/time`;
  const [gstatic, gstaticHttp, cloudflare, server, tcp1, tcp2] = await Promise.all([
    httpProbe(deps, 'https://connectivitycheck.gstatic.com/generate_204', true),
    httpProbe(deps, 'http://connectivitycheck.gstatic.com/generate_204', true),
    httpProbe(deps, 'https://1.1.1.1/cdn-cgi/trace'),
    httpProbe(deps, serverProbeUrl),
    (deps.tcp ?? tcpProbe)('1.1.1.1', 443, timeout),
    (deps.tcp ?? tcpProbe)('8.8.8.8', 53, timeout),
  ]);
  const serverPublic = !isPrivateHost(new URL(deps.serverUrl).hostname);
  const internet =
    gstatic.ok ||
    gstaticHttp.ok ||
    cloudflare.ok ||
    tcp1.ok ||
    tcp2.ok ||
    (server.ok && serverPublic);
  return {
    internet,
    serverReachable: server.ok,
    captive: Boolean((gstatic.ok && gstatic.captive) || (gstaticHttp.ok && gstaticHttp.captive)),
    probes: [gstatic, gstaticHttp, cloudflare, server, tcp1, tcp2].map((p) => ({
      ...p,
      target: p.target.slice(0, 200),
    })),
  };
}
