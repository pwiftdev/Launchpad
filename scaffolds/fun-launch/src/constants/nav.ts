// Primary navigation, shared by the side rail, mobile tab bar and command palette.

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** Icon when the item is active */
  activeIcon: string;
};

export const NAV_ITEMS: [NavItem, ...NavItem[]] = [
  { href: '/', label: 'Board', icon: 'ph--squares-four', activeIcon: 'ph--squares-four-fill' },
  { href: '/rules', label: 'Rules', icon: 'ph--book-open', activeIcon: 'ph--book-open-fill' },
  { href: '/roadmap', label: 'Roadmap', icon: 'ph--git-branch', activeIcon: 'ph--git-branch-fill' },
];

export const isActivePath = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);
