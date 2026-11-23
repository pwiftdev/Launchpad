import { SOCIAL_KINDS, SOCIAL_LABELS, type SocialKind, type Socials } from '@/lib/socials';
import { cn } from '@/lib/utils';

export const SOCIAL_ICONS: Record<SocialKind, string> = {
  website: 'ph--globe-simple-bold',
  twitter: 'ph--x-logo-bold',
  telegram: 'ph--telegram-logo-bold',
  discord: 'ph--discord-logo-bold',
};

/** Icon row for a coin's project links plus its source post, in a fixed order. */
export const SocialLinks = ({
  socials,
  source,
  className,
}: {
  socials?: Socials;
  source?: string;
  className?: string;
}) => {
  const links: [string, string, string][] = SOCIAL_KINDS.flatMap((kind) =>
    socials?.[kind] ? [[SOCIAL_LABELS[kind], socials[kind]!, SOCIAL_ICONS[kind]]] : []
  );
  if (source) links.push(['Source post on X', source, 'ph--quotes-bold']);
  if (!links.length) return null;
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {links.map(([label, href, icon]) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={label}
          title={label}
          onClick={(event) => event.stopPropagation()}
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-850 hover:text-foreground"
        >
          <span className={cn('iconify h-3.5 w-3.5', icon)} />
        </a>
      ))}
    </div>
  );
};
