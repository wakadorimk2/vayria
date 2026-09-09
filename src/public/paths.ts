// The public mount point has no trailing slash. The root mount is empty.
export const publicBasePath = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
export function publicUrl(path: string): string {
  if (!path.startsWith('/') || (publicBasePath && (path === publicBasePath || path.startsWith(publicBasePath + '/')))) return path;
  return publicBasePath + path;
}
export function publicPagePath(path: string): string {
  return publicBasePath && path.startsWith(publicBasePath + '/') ? path.slice(publicBasePath.length) : path;
}
