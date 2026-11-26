export const SOCIAL_KINDS = ['website', 'twitter', 'telegram', 'discord'] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];
export type Socials = Partial<Record<SocialKind, string>>;

export const SOCIAL_LABELS: Record<SocialKind, string> = {
  website: 'Website',
  twitter: 'X',
  telegram: 'Telegram',
  discord: 'Discord',
};
export const socialMaxLength = (kind: SocialKind) => (kind === 'twitter' ? 2048 : 200);

export function isSourcePostUrl(url: string): boolean {
  return /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}\/?(?:[?#].*)?$/.test(
    url.trim()
  );
}

/**
 * Canonical https link for one social field, or null when the value is not that kind of link.
 * Accepts bare handles and scheme-less input, so `@soap`, `t.me/soap` and `soap.fun` all work.
 * Idempotent: a canonical link normalizes to itself.
 */
export function normalizeSocial(kind: SocialKind, input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > socialMaxLength(kind) || /[\s<>"'`\\]/.test(raw)) return null;
  if (kind === 'twitter' && /^@?[A-Za-z0-9_]{1,15}$/.test(raw))
    return `https://x.com/${raw.replace(/^@/, '')}`;
  if (kind === 'telegram' && /^@[A-Za-z0-9_]{4,32}$/.test(raw))
    return `https://t.me/${raw.slice(1)}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, '');
  if (!/^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(host)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  switch (kind) {
    case 'website':
      return `https://${url.hostname.toLowerCase()}${path}${url.search}`;
    case 'twitter': {
      const primary = host === 'x.com' || host === 'twitter.com';
      if (!primary && !host.endsWith('.x.com') && !host.endsWith('.twitter.com')) return null;
      const canonicalHost = primary ? 'x.com' : url.hostname;
      const pathname = primary ? path || '/' : url.pathname;
      const link = `https://${canonicalHost}${pathname}${url.search}${url.hash}`;
      return link.length <= socialMaxLength(kind) ? link : null;
    }
    case 'telegram': {
      if (host !== 't.me' && host !== 'telegram.me') return null;
      const channel = path.match(/^\/(\+?[A-Za-z0-9_-]{4,64})$/);
      return channel ? `https://t.me/${channel[1]}` : null;
    }
    case 'discord': {
      const invite =
        host === 'discord.gg'
          ? path.match(/^\/([A-Za-z0-9-]{2,32})$/)
          : host === 'discord.com' || host === 'discordapp.com'
            ? path.match(/^\/invite\/([A-Za-z0-9-]{2,32})$/)
            : null;
      return invite ? `https://discord.gg/${invite[1]}` : null;
    }
  }
}

/** Keeps only valid links, in a fixed key order so signed payloads and cached JSON are stable. */
export function normalizeSocials(input: unknown): Socials {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const result: Socials = {};
  for (const kind of SOCIAL_KINDS) {
    const value = normalizeSocial(kind, fields[kind]);
    if (value) result[kind] = value;
  }
  return result;
}

export const hasSocials = (socials: Socials | undefined): socials is Socials =>
  !!socials && SOCIAL_KINDS.some((kind) => socials[kind]);
