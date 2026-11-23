import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletIdentity, ProfileAvatar } from './WalletIdentity';
import type { WalletProfile } from '@/lib/profiles';
const wallet = '5iskExampleWalletWithVisibleAddress123456789';
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());
const profile: WalletProfile = {
  wallet,
  username: 'holder',
  bio: '<script>alert(1)</script>',
  avatar_url: 'javascript:alert(1)',
  updated_at: '2026-01-01T00:00:00Z',
};
describe('public wallet identity rendering', () => {
  it('keeps wallet identity visible and escapes profile text without executing markup', () => {
    const html = renderToStaticMarkup(createElement(WalletIdentity, { wallet, profile }));
    expect(html).toContain('@holder');
    expect(html).toContain(wallet);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('src="javascript:');
  });
  it('does not apply another wallet profile or load unsupported avatars', () => {
    const html = renderToStaticMarkup(
      createElement(WalletIdentity, { wallet, profile: { ...profile, wallet: 'other' } })
    );
    expect(html).not.toContain('@holder');
    const avatar = renderToStaticMarkup(createElement(ProfileAvatar, { wallet, profile }));
    expect(avatar).not.toContain('<img');
  });
});
