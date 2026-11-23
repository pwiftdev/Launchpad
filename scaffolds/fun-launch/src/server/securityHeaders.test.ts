import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newScriptNonce, validScriptNonce } from './securityHeaders';

describe('per-response script policy', () => {
  it('uses unpredictable unique nonces and rejects header injection', () => {
    const first = newScriptNonce(),
      second = newScriptNonce();
    expect(first).not.toBe(second);
    expect(validScriptNonce(first)).toBe(true);
    expect(() => contentSecurityPolicy("x'; script-src *")).toThrow();
  });
  it('blocks inline/eval scripts, event attributes, framing and offsite form submissions in production', () => {
    const nonce = newScriptNonce(),
      policy = contentSecurityPolicy(nonce, false);
    const script = policy.split(';').find((item) => item.trim().startsWith('script-src '));
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain('unsafe-inline');
    expect(script).not.toContain('unsafe-eval');
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('http://127.0.0.1');
  });
  it('permits development bundling and only explicit loopback HTTP endpoints', () => {
    const policy = contentSecurityPolicy(newScriptNonce(), true);
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain('http://127.0.0.1:*');
    expect(policy).not.toContain('upgrade-insecure-requests');
  });
});
