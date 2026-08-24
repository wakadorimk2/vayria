import { X509Certificate } from 'node:crypto';

const SAN_FIELD_PATTERN =
  /(?:DNS(?:\s+Name)?|IP(?:\s+Address)?|DNS名|IPアドレス)\s*[:=]\s*([^,\s]+)/giu;

export function extractSubjectAlternativeNames(
  subjectAltName: string | null | undefined,
): string[] {
  if (!subjectAltName) return [];
  return [...subjectAltName.matchAll(SAN_FIELD_PATTERN)].map((match) => match[1]);
}

export function certificateHasSubjectAlternativeNames(
  subjectAltName: string | null | undefined,
  requiredNames: readonly string[],
): boolean {
  const names = new Set(
    extractSubjectAlternativeNames(subjectAltName).map((name) =>
      name.toLowerCase(),
    ),
  );
  return requiredNames.every((name) => names.has(name.toLowerCase()));
}

export function certificateIncludesSubjectAlternativeName(
  certificate: Buffer | string,
  requiredName: string,
): boolean {
  try {
    const parsed = new X509Certificate(certificate);
    return certificateHasSubjectAlternativeNames(
      parsed.subjectAltName,
      [requiredName],
    );
  } catch {
    return false;
  }
}
