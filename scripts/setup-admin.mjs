// Run locally in an interactive terminal. The key is never echoed or sent to Heroku.
import { emitKeypressEvents } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashAdminKey } from './admin-key.cjs';

function authToken() {
  if (process.env.HEROKU_API_KEY) return process.env.HEROKU_API_KEY;
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
  try {
    return execFileSync('heroku auth:token', { ...options, shell: true }).trim();
  } catch {
    // Also support an existing npx-installed CLI without installing anything new.
    const cache =
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
        : path.join(os.homedir(), '.npm', '_npx');
    for (const directory of existsSync(cache) ? readdirSync(cache) : []) {
      const entry = path.join(cache, directory, 'node_modules', 'heroku', 'bin', 'run.js');
      if (existsSync(entry)) {
        try {
          return execFileSync(process.execPath, [entry, 'auth:token'], options).trim();
        } catch {
          /* Try another already-installed CLI. */
        }
      }
    }
    throw new Error('Log in to the Heroku CLI, then run this command again.');
  }
}

function hiddenInput(prompt) {
  process.stdout.write(prompt);
  const previous = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(previous);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') return finish(new Error('Setup cancelled.'));
      if (key?.name === 'return') return finish();
      if (key?.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (!key?.ctrl && !key?.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

try {
  if (!process.stdin.isTTY)
    throw new Error('Run this command in your own terminal for private key entry.');
  if (process.argv.length !== 2)
    throw new Error('Run without arguments; enter the admin key at the hidden prompt.');
  const token = authToken();
  const app = 'rinsed-launchpad';
  const api = async (method, body) => {
    const response = await fetch(`https://api.heroku.com/apps/${app}/config-vars`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error('Could not update Heroku settings; no key details were printed.');
    return response.json();
  };
  const current = await api('GET');
  if (!current.DATABASE_URL || (current.WHITELIST_SECRET?.length ?? 0) < 32)
    throw new Error('Registration storage must be configured before admin sign-in.');
  console.log(`Set the private admin key for ${app}. Existing admin sessions will be signed out.`);
  console.log(
    'Use a unique key from your password manager, at least 16 characters. Input stays hidden.'
  );
  emitKeypressEvents(process.stdin);
  const key = await hiddenInput('Choose admin key: ');
  const confirmed = await hiddenInput('Confirm admin key: ');
  if (key !== confirmed) throw new Error('Keys did not match. No changes made.');
  const hash = await hashAdminKey(key);
  await api('PATCH', {
    ADMIN_KEY_HASH: hash,
    ADMIN_SESSION_SECRET: randomBytes(48).toString('base64url'),
  });
  console.log(
    `Admin key configured. Sign in at ${new URL(current.NEXT_PUBLIC_SITE_URL).origin}/admin`
  );
  console.log(
    'Keep the key in your password manager. The key itself was not stored in the app settings.'
  );
} catch (error) {
  console.error(
    error.message?.startsWith('Use an admin key') ||
      ['Setup cancelled.', 'Keys did not match. No changes made.'].includes(error.message)
      ? error.message
      : 'Admin setup could not complete. Run in an interactive terminal with the Heroku CLI logged in; no key details were printed.'
  );
  process.exitCode = 1;
}
