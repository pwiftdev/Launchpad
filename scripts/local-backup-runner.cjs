/* VM-only credential transport for the isolated TLS restore drill. Never accepts a hosted URL. */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
async function main() {
  if (process.platform !== 'linux') throw new Error('Run only in isolated Linux VM');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 5000) throw new Error('Oversized local configuration'); }
  const url = new URL(JSON.parse(input).databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '55432' || url.pathname !== '/rinsed_local' || decodeURIComponent(url.username) !== 'rinsed_local')
    throw new Error('Only the pinned isolated test database credential is allowed');
  const directory = '/var/lib/postgresql/rinsed-drills';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const uid = Number(spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).stdout.trim());
  const gid = Number(spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).stdout.trim());
  fs.chownSync(directory, uid, gid);
  const passfile = `${directory}/.pgpass-${process.pid}`;
  const rawPassword = decodeURIComponent(url.password);
  if (!rawPassword || /[\r\n\0]/.test(rawPassword)) throw new Error('Invalid isolated test credential');
  const password = rawPassword.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  fs.writeFileSync(passfile, `127.0.0.1:5432:*:rinsed_local:${password}\n`, { mode: 0o600, flag: 'wx' });
  fs.chownSync(passfile, uid, gid);
  try {
    const result = spawnSync('runuser', ['-u', 'postgres', '--', 'bash', '/tmp/rinsed-local-backup-drill.sh'], {
      cwd: '/tmp', stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, RINSED_BACKUP_TLS: 'true',
        PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'rinsed_local', PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/var/lib/postgresql/rinsed-server.crt', PGPASSFILE: passfile },
    });
    if (result.status !== 0) throw new Error('Isolated TLS restore drill failed');
  } finally { fs.unlinkSync(passfile); }
}
main().catch(() => { console.error('Local TLS backup runner failed; private connection settings withheld.'); process.exitCode = 1; });
