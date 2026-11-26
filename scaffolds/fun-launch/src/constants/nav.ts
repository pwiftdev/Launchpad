// Primary navigation, shared by the side rail, mobile tab bar and command palette.

export const OTC_PATH = '/otc';

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Icon when the item is active */
  activeIcon: string;
};

export const NAV_ITEMS: [NavItem, ...NavItem[]] = [
  { href: '/', label: 'Board', icon: 'ph--squares-four', activeIcon: 'ph--squares-four-fill' },
  {
    href: OTC_PATH,
    label: 'OTC',
    icon: 'ph--arrows-left-right',
    activeIcon: 'ph--arrows-left-right-bold',
  },
  { href: '/burns', label: 'Burns', icon: 'ph--fire', activeIcon: 'ph--fire-fill' },
  { href: '/rules', label: 'Rules', icon: 'ph--book-open', activeIcon: 'ph--book-open-fill' },
  { href: '/roadmap', label: 'Roadmap', icon: 'ph--git-branch', activeIcon: 'ph--git-branch-fill' },
];

export const isActivePath = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);

export function requiresDocumentNavigation(from: string, to: string) {
  return (from === OTC_PATH) !== (to === OTC_PATH);
}

export function navigateDocument(from: string, to: string) {
  if (!requiresDocumentNavigation(from, to)) return;
  return (event: { preventDefault: () => void }) => {
    event.preventDefault();
    window.location.assign(to);
  };
}
