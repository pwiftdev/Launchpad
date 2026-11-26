import { createHmac } from 'node:crypto';
import {
  derivePrivateKey,
  openPrivate,
  privateCookie,
  privateKey,
  privateSession,
  readPrivateSession,
  sealPrivate,
} from './privateEncryption';

export const CHAT_COOKIE = '__Host-mskd_chat';
export const chatKey = () => privateKey(process.env.TOKEN_CHAT_SECRET);
const derive = (secret: Buffer, scope: string) =>
  derivePrivateKey(secret, `mskd-token-chat/v1/${scope}`);

export function chatRoom(secret: Buffer, genesis: string, mint: string) {
  const room = JSON.stringify([genesis, mint]);
  const messageKey = derive(secret, `message/${room}`);
  const aliasKey = derive(secret, `alias/${room}`);
  const context = (author: string, id: string) => JSON.stringify([room, author, id]);
  return {
    author: (wallet: string) =>
      createHmac('sha256', aliasKey).update(wallet).digest('hex').slice(0, 16),
    encrypt: (author: string, id: string, body: string) =>
      sealPrivate(messageKey, context(author, id), body),
    decrypt: (author: string, id: string, ciphertext: Buffer) =>
      openPrivate(messageKey, context(author, id), ciphertext),
  };
}

export const chatCookie = (value: string, maxAge?: number) =>
  privateCookie(CHAT_COOKIE, value, maxAge);

export const chatSession = (
  secret: Buffer,
  wallet: string,
  origin: string,
  genesis: string,
  now?: number
) => privateSession(derive(secret, 'session'), wallet, origin, genesis, now);

export const readChatSession = (
  secret: Buffer,
  value: string | undefined,
  origin: string,
  genesis: string,
  now?: number
) => readPrivateSession(derive(secret, 'session'), value, origin, genesis, now);
