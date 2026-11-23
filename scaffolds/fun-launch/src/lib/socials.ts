export const SOCIAL_KINDS = ['website', 'twitter', 'telegram', 'discord'] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];
export type Socials = Partial<Record<SocialKind, string>>;

export const SOCIAL_LABELS: Record<SocialKind, string> = {
  website: 'Website',
  twitter: 'X',
  telegram: 'Telegram',
  discord: 'Discord',
};
export const SOCIAL_MAX_LENGTH = 200;

const X_RESERVED = new Set(['home', 'search', 'explore', 'i', 'intent', 'share', 'settings']);

/**
 * Canonical https link for one social field, or null when the value is not that kind of link.
 * Accepts bare handles and scheme-less input, so `@soap`, `t.me/soap` and `soap.fun` all work.
 * Idempotent: a canonical link normalizes to itself.
 */
export function normalizeSocial(kind: SocialKind, input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > SOCIAL_MAX_LENGTH || /[\s<>"'`\\]/.test(raw)) return null;
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
      if (host !== 'x.com' && host !== 'twitter.com') return null;
      const profile = path.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (profile?.[1] && !X_RESERVED.has(profile[1].toLowerCase()))
        return `https://x.com/${profile[1]}`;
      const community = path.match(/^\/i\/communities\/(\d{5,25})$/);
      return community ? `https://x.com/i/communities/${community[1]}` : null;
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
