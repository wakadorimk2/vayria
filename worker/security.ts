import { LimitError } from './ledger';
const encoder = new TextEncoder();
function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(s: string) { return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
async function key(secret: string) {
  if (secret.length < 32) throw new LimitError('configuration_unavailable', 0, 503);
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(value: object, secret: string) {
  const body = base64(encoder.encode(JSON.stringify(value)));
  return body + '.' + base64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body))));
}
export async function verify<T extends { exp: number }>(token: string, secret: string, allowExpired = false): Promise<T | null> {
  try {
    if (token.length > 12000) return null;
    const [body, signature, extra] = token.split('.');
    if (extra || !body || !signature) return null;
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(signature), encoder.encode(body))) return null;
    const value = JSON.parse(new TextDecoder().decode(decode(body))) as T;
    return Number.isFinite(value.exp) && (allowExpired || value.exp > Date.now()) ? value : null;
  } catch { return null; }
}
export function cookie(request: Request, name: string) {
  return (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}
export async function ipKey(request: Request, secret: string) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) throw new LimitError('connection_unavailable', 0, 503);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(day + ':' + ip))));
}
export async function boundedBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new LimitError('request_too_large', 0, 413); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}
export function wavSeconds(bytes: Uint8Array) {
  if (bytes.byteLength < 44) throw new LimitError('invalid_audio', 0, 400);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  const size = bytes.byteLength - 44;
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE' || ascii(12, 16) !== 'fmt ' ||
    ascii(36, 40) !== 'data' || v.getUint32(4, true) !== bytes.length - 8 || v.getUint32(16, true) !== 16 ||
    v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== 16000 ||
    v.getUint32(28, true) !== 32000 || v.getUint16(32, true) !== 2 || v.getUint16(34, true) !== 16 ||
    v.getUint32(40, true) !== size || size % 2 || size < 3200 || size > 640000) throw new LimitError('invalid_audio', 0, 400);
  return size / 32000;
}
