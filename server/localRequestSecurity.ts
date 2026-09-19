import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';

/** Reject foreign browser requests and DNS-rebinding hosts before local API work. */
export function isAllowedLocalRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const authority = request.headers.host ?? request.headers[':authority'];
  // Native clients and in-process callers can omit browser headers.
  if (authority === undefined) return origin === undefined;
  if (typeof authority !== 'string') return false;
  try {
    const encrypted = request.socket && 'encrypted' in request.socket && request.socket.encrypted;
    const target = new URL(`${encrypted ? 'https' : 'http'}://${authority}`);
    const localAddress = request.socket?.localAddress?.replace(/^::ffff:/, '');
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) return false;
    if (!['localhost', '127.0.0.1', '::1', 'vayria.local', hostname().toLowerCase(), localAddress].includes(host)) return false;
    return origin === undefined || origin === target.origin;
  } catch {
    return false;
  }
}
