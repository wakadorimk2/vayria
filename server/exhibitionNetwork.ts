import { createRequire } from 'node:module';
import * as os from 'node:os';
import type { Plugin } from 'vite';
import type {
  ExhibitionAccess,
  MdnsStatus,
} from '../src/networkState.js';
import { certificateIncludesSubjectAlternativeName } from './certificateSan.js';

export const EXHIBITION_HOSTNAME = 'vayria.local';
export const EXHIBITION_SSID = 'Vayria-Exhibition';
export const MDNS_PORT = 5353;
export const DEFAULT_EXHIBITION_PORT = 5187;

const HOTSPOT_INTERFACE_PATTERN =
  /wi[- ]?fi\s+direct|mobile\s+hotspot|local\s+area\s+connection|ローカル\s*エリア\s*接続|モバイル\s*ホットスポット/iu;

interface NodeNetworkInterfaceInfo {
  address: string;
  netmask: string;
  family: string | number;
  mac: string;
  internal: boolean;
  cidr: string | null;
  scopeid?: number;
}

export interface HotspotAddress {
  interfaceName: string;
  address: string;
}

export interface HotspotAddressSelectionOptions {
  preferredIp?: string;
  preferredInterface?: string;
}

export type NetworkInterfacesSnapshot = Record<
  string,
  readonly NodeNetworkInterfaceInfo[] | undefined
>;

export interface MulticastDnsQuestion {
  name: string;
  type: string;
  class?: string | number;
}

export interface MulticastDnsAnswer {
  name: string;
  type: string;
  class?: string | number;
  ttl?: number;
  flush?: boolean;
  data: string;
}

export interface MulticastDnsPacket {
  questions?: MulticastDnsQuestion[];
  answers?: MulticastDnsAnswer[];
}

export interface MulticastDnsClient {
  on(event: 'query' | 'response' | 'error', listener: (packet: MulticastDnsPacket | Error) => void): this;
  query(packet: { questions: MulticastDnsQuestion[] }): void;
  respond(packet: { answers: MulticastDnsAnswer[] }): void;
  destroy(): void;
}

export type MulticastDnsFactory = (options: {
  interface?: string;
  port?: number;
  reuseAddr?: boolean;
}) => MulticastDnsClient;

export interface ExhibitionNetworkRuntime {
  start(): void;
  stop(): void;
  getAccess(port?: number, httpsEnabled?: boolean): ExhibitionAccess;
  getHotspotAddress(): HotspotAddress | null;
  getMdnsStatus(): MdnsStatus;
}

export interface ExhibitionNetworkOptions extends HotspotAddressSelectionOptions {
  enabled?: boolean;
  mdnsEnabled?: boolean;
  hostname?: string;
  networkInterfaces?: () => NetworkInterfacesSnapshot;
  mdnsFactory?: MulticastDnsFactory;
  scanIntervalMs?: number;
  httpsCertificate?: Buffer | string;
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/\.+$/u, '').toLowerCase();
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/u.test(octet)) return false;
      const number = Number(octet);
      return number >= 0 && number <= 255;
    })
  );
}

function isUsableIpv4Address(value: string, internal = false): boolean {
  if (!isIpv4Address(value) || internal) return false;
  if (value === '0.0.0.0' || value.startsWith('127.')) return false;
  if (value.startsWith('169.254.')) return false;
  return true;
}

function isPreferredInterface(
  name: string,
  preferredInterface: string | undefined,
): boolean {
  return Boolean(
    preferredInterface &&
      name.localeCompare(preferredInterface, undefined, {
        sensitivity: 'accent',
      }) === 0,
  );
}

export function selectHotspotAddress(
  interfaces: NetworkInterfacesSnapshot = os.networkInterfaces() as NetworkInterfacesSnapshot,
  options: HotspotAddressSelectionOptions = {},
): HotspotAddress | null {
  const candidates: Array<HotspotAddress & { score: number }> = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const interfaceLooksLikeHotspot = HOTSPOT_INTERFACE_PATTERN.test(interfaceName);
    if (
      !interfaceLooksLikeHotspot &&
      !options.preferredIp &&
      !options.preferredInterface
    ) {
      continue;
    }
    for (const entry of entries) {
      const family = String(entry.family).toLowerCase();
      if (family !== 'ipv4' && family !== '4') continue;
      if (!isUsableIpv4Address(entry.address, entry.internal)) continue;
      if (
        options.preferredIp &&
        options.preferredIp.trim() !== entry.address
      ) {
        continue;
      }
      if (
        options.preferredInterface &&
        !isPreferredInterface(interfaceName, options.preferredInterface) &&
        !options.preferredIp
      ) {
        continue;
      }

      const score =
        (options.preferredIp === entry.address ? 100 : 0) +
        (isPreferredInterface(interfaceName, options.preferredInterface)
          ? 50
          : 0) +
        (interfaceLooksLikeHotspot ? 20 : 0);
      candidates.push({ interfaceName, address: entry.address, score });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.interfaceName.localeCompare(right.interfaceName);
  });
  const selected = candidates[0];
  return selected
    ? { interfaceName: selected.interfaceName, address: selected.address }
    : null;
}

export function formatExhibitionAccess(options: {
  port?: number;
  httpsEnabled?: boolean;
  hostname?: string;
  hotspotIp?: string | null;
  mdns?: MdnsStatus;
  fallbackTlsValid?: boolean;
}): ExhibitionAccess {
  const port = options.port ?? DEFAULT_EXHIBITION_PORT;
  const hostname = options.hostname ?? EXHIBITION_HOSTNAME;
  const scheme = options.httpsEnabled ? 'https' : 'http';
  const primaryUrl = `${scheme}://${hostname}:${port}`;
  const hotspotIp = options.hotspotIp ?? null;
  const fallbackUrl = hotspotIp ? `${scheme}://${hotspotIp}:${port}` : null;
  const fallbackTlsValid = options.fallbackTlsValid ?? !options.httpsEnabled;
  const mdns = options.mdns ?? 'unavailable';
  return {
    hostname,
    port,
    scheme,
    primaryUrl,
    fallbackUrl,
    fallbackTlsValid,
    recommendedUrl:
      mdns === 'available'
        ? primaryUrl
        : fallbackTlsValid
          ? fallbackUrl
          : null,
    mdns,
    hotspotIp,
  };
}

function getDefaultMulticastDnsFactory(): MulticastDnsFactory | null {
  try {
    const require = createRequire(import.meta.url);
    const module = require('multicast-dns') as
      | MulticastDnsFactory
      | { default?: MulticastDnsFactory };
    return typeof module === 'function'
      ? module
      : typeof module.default === 'function'
        ? module.default
        : null;
  } catch {
    return null;
  }
}

export function createExhibitionNetworkRuntime(
  options: ExhibitionNetworkOptions = {},
): ExhibitionNetworkRuntime {
  const enabled = options.enabled ?? true;
  const mdnsEnabled = options.mdnsEnabled ?? true;
  const hostname = normalizeHostname(options.hostname ?? EXHIBITION_HOSTNAME);
  const readInterfaces =
    options.networkInterfaces ??
    (() => os.networkInterfaces() as NetworkInterfacesSnapshot);
  const mdnsFactory = options.mdnsFactory ?? getDefaultMulticastDnsFactory();
  const scanIntervalMs = Math.max(0, options.scanIntervalMs ?? 5_000);
  let started = false;
  let currentAddress: HotspotAddress | null = null;
  let mdns: MulticastDnsClient | null = null;
  let mdnsStatus: MdnsStatus = 'unavailable';
  let scanTimer: ReturnType<typeof setInterval> | null = null;

  const destroyMdns = (): void => {
    const activeMdns = mdns;
    mdns = null;
    if (!activeMdns) return;
    try {
      activeMdns.destroy();
    } catch {
      // mDNS shutdown is best effort and must not stop the exhibition server.
    }
  };

  const resolveAddress = (): HotspotAddress | null =>
    selectHotspotAddress(readInterfaces(), {
      preferredIp: options.preferredIp,
      preferredInterface: options.preferredInterface,
    });

  const advertise = (): void => {
    if (!started || !mdnsEnabled || !currentAddress || !mdnsFactory) {
      mdnsStatus = 'unavailable';
      return;
    }

    try {
      const activeMdns = mdnsFactory({
        interface: currentAddress.address,
        port: MDNS_PORT,
        reuseAddr: true,
      });
      mdns = activeMdns;
      mdnsStatus = 'available';
      activeMdns.on('query', (packet) => {
        if (!(packet && 'questions' in packet)) return;
        const questions = packet.questions ?? [];
        if (
          !questions.some(
            (question) =>
              normalizeHostname(question.name) === hostname &&
              (question.type === 'A' || question.type === 'ANY'),
          )
        ) {
          return;
        }
        try {
          activeMdns.respond({
            answers: [
              {
                name: hostname,
                type: 'A',
                class: 'IN',
                ttl: 120,
                flush: true,
                data: currentAddress?.address ?? '',
              },
            ],
          });
        } catch {
          mdnsStatus = 'unavailable';
        }
      });
      activeMdns.on('response', (packet) => {
        if (!(packet && 'answers' in packet)) return;
        const conflictingAnswer = (packet.answers ?? []).find(
          (answer) =>
            normalizeHostname(answer.name) === hostname &&
            answer.type === 'A' &&
            answer.data !== currentAddress?.address,
        );
        if (!conflictingAnswer) return;
        mdnsStatus = 'conflict';
        destroyMdns();
      });
      activeMdns.on('error', () => {
        mdnsStatus = 'unavailable';
        destroyMdns();
      });
      activeMdns.query({
        questions: [{ name: hostname, type: 'A', class: 'IN' }],
      });
    } catch {
      mdnsStatus = 'unavailable';
      destroyMdns();
    }
  };

  const refresh = (): void => {
    const nextAddress = resolveAddress();
    const addressChanged =
      currentAddress?.interfaceName !== nextAddress?.interfaceName ||
      currentAddress?.address !== nextAddress?.address;
    if (!addressChanged) return;

    destroyMdns();
    currentAddress = nextAddress;
    mdnsStatus = 'unavailable';
    if (currentAddress) advertise();
  };

  return {
    start() {
      if (!enabled || started) return;
      started = true;
      refresh();
      if (scanIntervalMs > 0) {
        scanTimer = setInterval(refresh, scanIntervalMs);
      }
    },
    stop() {
      started = false;
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
      destroyMdns();
      currentAddress = null;
      mdnsStatus = 'unavailable';
    },
    getAccess(port = DEFAULT_EXHIBITION_PORT, httpsEnabled = false) {
      return formatExhibitionAccess({
        port,
        httpsEnabled,
        hostname,
        hotspotIp: currentAddress?.address ?? null,
        mdns: mdnsStatus,
        fallbackTlsValid:
          !httpsEnabled ||
          Boolean(
            currentAddress &&
              options.httpsCertificate &&
              certificateIncludesSubjectAlternativeName(
                options.httpsCertificate,
                currentAddress.address,
              ),
          ),
      });
    },
    getHotspotAddress() {
      return currentAddress;
    },
    getMdnsStatus() {
      return mdnsStatus;
    },
  };
}

export function exhibitionNetworkPlugin(
  runtime: ExhibitionNetworkRuntime,
  options: { bindHost: string; port: number; httpsEnabled: boolean },
): Plugin {
  return {
    name: 'vayria-exhibition-network',
    configureServer(server) {
      const report = (): void => {
        runtime.start();
        const access = runtime.getAccess(options.port, options.httpsEnabled);
        console.info(
          '[exhibition-network]',
          `bind=${options.bindHost}:${options.port}`,
          `mdns=${access.mdns}`,
          `hotspotIp=${access.hotspotIp ?? 'unavailable'}`,
        );
        console.info(
          '[exhibition-network]',
          `primary=${access.primaryUrl}`,
          `fallback=${access.fallbackUrl ?? 'unavailable'}`,
          `health=${access.recommendedUrl ? `${access.recommendedUrl}/api/health` : 'unavailable'}`,
        );
      };

      if (server.httpServer?.listening) {
        report();
      } else {
        server.httpServer?.once('listening', report);
      }
      server.httpServer?.once('close', () => runtime.stop());
    },
  };
}
