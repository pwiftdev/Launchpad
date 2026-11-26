import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletIdentity } from './WalletIdentity';
const wallet = '5iskExampleWalletWithVisibleAddress123456789';
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());
describe('public wallet identity rendering', () => {
  it('shows a shortened address and keeps the full wallet in the title', () => {
    const html = renderToStaticMarkup(createElement(WalletIdentity, { wallet }));
    expect(html).toContain(`title="${wallet}"`);
    expect(html).toContain('data-private');
  });
});
