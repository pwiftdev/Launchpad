import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { ProfileStore, SocialError } from './profileStore';
import { privateCookie, privateSession, readPrivateSession } from './privateEncryption';

export class PrivateWalletAccess {
  constructor(
    private key: Buffer,
    private purpose: 'launch-preview' | 'otc',
    private cookie: string,
    private walletHeader: string,
    private origin: string,
    private genesis: string
  ) {}

  challenge(wallet: string) {
    return new ProfileStore().challenge(wallet, this.purpose, this.origin, {
      networkGenesis: this.genesis,
    });
  }

  async join(wallet: string, nonce: string, signature: string, res: NextApiResponse) {
    const verified = await new ProfileStore().submit(
      wallet,
      this.purpose,
      this.origin,
      nonce,
      signature
    );
    if (!z.object({ networkGenesis: z.literal(this.genesis) }).safeParse(verified).success)
      throw new SocialError('Sign in with the current network.', 401);
    const session = privateSession(this.key, wallet, this.origin, this.genesis);
    res.setHeader('Set-Cookie', privateCookie(this.cookie, session));
  }

  wallet(req: NextApiRequest): string | null {
    const wallet = readPrivateSession(
      this.key,
      req.cookies?.[this.cookie],
      this.origin,
      this.genesis
    );
    return req.headers[this.walletHeader.toLowerCase()] === wallet ? wallet : null;
  }
}
