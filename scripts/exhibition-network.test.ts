import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExhibitionNetworkRuntime,
  formatExhibitionAccess,
  selectHotspotAddress,
  type MulticastDnsClient,
  type MulticastDnsFactory,
  type MulticastDnsPacket,
  type MulticastDnsQuestion,
  type NetworkInterfacesSnapshot,
} from '../server/exhibitionNetwork.js';
import { createInternetConnectivityProbe } from '../server/internetConnectivity.js';
import {
  certificateHasSubjectAlternativeNames,
  extractSubjectAlternativeNames,
} from '../server/certificateSan.js';

const INTERFACES = {
  'Wi-Fi': [
    {
      address: '192.168.1.15',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.15/24',
    },
  ],
  'Local Area Connection* 12': [
    {
      address: '192.168.137.1',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: '192.168.137.1/24',
    },
  ],
};

class FakeMdnsClient implements MulticastDnsClient {
  readonly responses: Array<{ answers: Array<{ name: string; data: string }> }> = [];
  readonly queries: MulticastDnsQuestion[][] = [];
  destroyed = false;
  private readonly listeners = new Map<string, Array<(packet: MulticastDnsPacket | Error) => void>>();

  on(
    event: 'query' | 'response' | 'error',
    listener: (packet: MulticastDnsPacket | Error) => void,
  ): this {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  query(packet: { questions: MulticastDnsQuestion[] }): void {
    this.queries.push(packet.questions);
  }

  respond(packet: { answers: Array<{ name: string; data: string }> }): void {
    this.responses.push(packet);
  }

  destroy(): void {
    this.destroyed = true;
  }

  emit(event: 'query' | 'response' | 'error', packet: MulticastDnsPacket | Error): void {
    for (const listener of this.listeners.get(event) ?? []) listener(packet);
  }
}

function createFakeMdnsFactory(): {
  factory: MulticastDnsFactory;
  clients: FakeMdnsClient[];
} {
  const clients: FakeMdnsClient[] = [];
  return {
    clients,
    factory: () => {
      const client = new FakeMdnsClient();
      clients.push(client);
      return client;
    },
  };
}

test('selectHotspotAddress prefers a named hotspot adapter and follows its changed IP', () => {
  assert.deepEqual(selectHotspotAddress(INTERFACES), {
    interfaceName: 'Local Area Connection* 12',
    address: '192.168.137.1',
  });
  assert.deepEqual(
    selectHotspotAddress(INTERFACES, { preferredIp: '192.168.1.15' }),
    { interfaceName: 'Wi-Fi', address: '192.168.1.15' },
  );
  assert.deepEqual(
    selectHotspotAddress(INTERFACES, {
      preferredInterface: 'Local Area Connection* 12',
    }),
    {
      interfaceName: 'Local Area Connection* 12',
      address: '192.168.137.1',
    },
  );
  assert.equal(
    selectHotspotAddress({
      'vEthernet (WSL (Hyper-V firewall))': INTERFACES['Wi-Fi'],
    }),
    null,
  );
});

test('formatExhibitionAccess keeps the primary hostname and dynamic fallback distinct', () => {
  assert.deepEqual(
    formatExhibitionAccess({
      port: 5187,
      httpsEnabled: true,
      hotspotIp: '192.168.137.42',
      mdns: 'available',
    }),
    {
      hostname: 'vayria.local',
      port: 5187,
      scheme: 'https',
      primaryUrl: 'https://vayria.local:5187',
      fallbackUrl: 'https://192.168.137.42:5187',
      fallbackTlsValid: false,
      recommendedUrl: 'https://vayria.local:5187',
      mdns: 'available',
      hotspotIp: '192.168.137.42',
    },
  );
  assert.equal(
    formatExhibitionAccess({
      port: 5187,
      httpsEnabled: true,
      hotspotIp: '192.168.137.42',
      mdns: 'conflict',
    }).recommendedUrl,
    null,
  );
});

test('mDNS advertises on the selected interface, detects conflicts, and follows IP changes', async () => {
  let currentInterfaces: NetworkInterfacesSnapshot = INTERFACES;
  const fake = createFakeMdnsFactory();
  const runtime = createExhibitionNetworkRuntime({
    networkInterfaces: () => currentInterfaces,
    mdnsFactory: fake.factory,
    scanIntervalMs: 2,
  });

  runtime.start();
  assert.equal(runtime.getHotspotAddress()?.address, '192.168.137.1');
  assert.equal(runtime.getMdnsStatus(), 'available');
  assert.equal(fake.clients[0].queries[0][0].name, 'vayria.local');
  fake.clients[0].emit('query', {
    questions: [{ name: 'vayria.local', type: 'A' }],
  });
  assert.equal(fake.clients[0].responses[0].answers[0].data, '192.168.137.1');

  fake.clients[0].emit('response', {
    answers: [{ name: 'vayria.local', type: 'A', data: '192.168.137.99' }],
  });
  assert.equal(runtime.getMdnsStatus(), 'conflict');
  assert.equal(runtime.getAccess(5187, true).recommendedUrl, null);

  currentInterfaces = {
    ...INTERFACES,
    'Local Area Connection* 12': [
      {
        ...INTERFACES['Local Area Connection* 12'][0],
        address: '192.168.137.2',
        cidr: '192.168.137.2/24',
      },
    ],
  };
  await new Promise<void>((resolve) => setTimeout(resolve, 8));
  assert.equal(runtime.getHotspotAddress()?.address, '192.168.137.2');
  assert.equal(fake.clients.length, 2);
  runtime.stop();
  assert.equal(runtime.getMdnsStatus(), 'unavailable');
});

test('mDNS socket failures leave the fallback URL available', () => {
  const runtime = createExhibitionNetworkRuntime({
    networkInterfaces: () => INTERFACES,
    mdnsFactory: () => {
      throw new Error('UDP 5353 is occupied');
    },
    scanIntervalMs: 0,
  });
  runtime.start();
  assert.equal(runtime.getMdnsStatus(), 'unavailable');
  assert.equal(runtime.getAccess(5187, true).fallbackUrl, 'https://192.168.137.1:5187');
  runtime.stop();
});

test('Internet probe caches both success and failure without failing the caller', async () => {
  let now = 0;
  let calls = 0;
  const probe = createInternetConnectivityProbe({
    cacheMs: 1_000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    },
  });
  assert.equal(await probe.check(), 'unavailable');
  assert.equal(await probe.check(), 'unavailable');
  assert.equal(calls, 1);
  now = 1_001;
  assert.equal(await probe.check(), 'unavailable');
  assert.equal(calls, 2);
});

test('certificate SAN parsing accepts the hostname and loopback names required by exhibition', () => {
  const san = 'DNS:vayria.local, DNS:localhost, IP Address:127.0.0.1';
  assert.deepEqual(extractSubjectAlternativeNames(san), [
    'vayria.local',
    'localhost',
    '127.0.0.1',
  ]);
  assert.equal(
    certificateHasSubjectAlternativeNames(san, [
      'vayria.local',
      'localhost',
      '127.0.0.1',
    ]),
    true,
  );
  assert.equal(certificateHasSubjectAlternativeNames(san, ['192.168.137.1']), false);
});
