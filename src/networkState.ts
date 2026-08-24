export type NetworkAvailability = 'available' | 'unavailable';

export type VayriaAppMode = 'local' | 'exhibition' | 'public';

export type MdnsStatus = 'available' | 'unavailable' | 'conflict';

export interface NetworkState {
  localNetwork: NetworkAvailability;
  internet: NetworkAvailability;
}

export interface ExhibitionAccess {
  hostname: string;
  port: number;
  scheme: 'http' | 'https';
  primaryUrl: string;
  fallbackUrl: string | null;
  fallbackTlsValid: boolean;
  recommendedUrl: string | null;
  mdns: MdnsStatus;
  hotspotIp: string | null;
}

export interface VayriaHealthResponse {
  ok: true;
  service: 'vayria';
  mode: VayriaAppMode;
  network: NetworkState;
  access?: ExhibitionAccess;
}
