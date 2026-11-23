/** Exact server-configured origins; never trust an arbitrary Host or forwarded host. */
export function siteOrigins(): string[] {
  const values = [
    process.env.NEXT_PUBLIC_SITE_URL,
    ...(process.env.SITE_ALLOWED_ORIGINS ?? '').split(','),
  ];
  return [
    ...new Set(values.filter((value): value is string => !!value).map((value) => value.trim())),
  ].filter((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  });
}

export function siteOriginForHeaders(headers: { origin?: string; host?: string }): string {
  const origins = siteOrigins();
  if (headers.origin && origins.includes(headers.origin)) return headers.origin;
  const selected = origins.find((origin) => new URL(origin).host === headers.host) ?? origins[0];
  if (!selected) throw new Error('Site origin is not configured');
  return selected;
}
