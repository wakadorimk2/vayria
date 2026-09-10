export function adminTarget(value) {
  const url = new URL(value ?? 'https://invalid.invalid');
  if (url.protocol !== 'https:' || url.hostname !== 'vayria.me' || url.port || url.username || url.password || url.search || url.hash ||
      !['/', '/staging', '/staging/'].includes(url.pathname)) throw new Error('Use VAYRIA_ADMIN_URL=https://vayria.me or https://vayria.me/staging');
  const staging = url.pathname.startsWith('/staging');
  return { staging, url: new URL(staging ? '/staging/api/admin' : '/api/admin', url) };
}
