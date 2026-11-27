export function axiomLink(referral = process.env.NEXT_PUBLIC_AXIOM_REFERRAL_URL) {
  const active = /^https:\/\/axiom\.trade\/@[a-zA-Z0-9_-]{1,64}\/?$/.test(referral ?? '');
  return { href: active ? referral! : 'https://axiom.trade/', referral: active };
}
