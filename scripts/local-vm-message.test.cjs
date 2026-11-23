const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { walletRewardMessageAllowed } = require('./local-vm-signer.cjs');
const genesis = 'GxBSPRteo4BvjKLkKC3AYeK2EVnCtsTpFa2W4qxr4J6H',
  wallet = 'BX14eg9nZEZMD1WcUeQSmeoRFFUd7NxS5BxZnBmhEY1e',
  mint = 'ASqF4NEvDz98HefQNpk83182VyCqUm4ZMNdRsiY5uKNq',
  now = 1793202183772;
const message = (epoch = 'creator') =>
  `Request a SOL reward payout on http://127.0.0.1:3003\nPolicy: rinsed-wallet-payout-v1\nNetwork genesis: ${genesis}\nWallet: ${wallet}\nMint: ${mint}\nEpoch: ${epoch}\nAmount (lamports): 500218\nRequest: b01583bd-655d-434c-bff4-c0db8c1f124f\nIssued at: ${now}\nSend this reward only to the wallet above. No transaction signature or token approval is requested.`;
const context = { genesis, wallet, role: 'trader', now };
test('VM helper permits only exact wallet-v1 local SOL payout authorization for bound role/wallet/genesis', () => {
  assert(walletRewardMessageAllowed(message(), context));
  assert(walletRewardMessageAllowed(message('498101'), context));
  assert(!walletRewardMessageAllowed(message(), { ...context, role: 'foreign' }));
  assert(!walletRewardMessageAllowed(message(), { ...context, wallet: mint }));
  assert(!walletRewardMessageAllowed(message(), { ...context, genesis: wallet }));
});
test('VM helper rejects changed origin/policy, payout bounds, epochs, nonces, stale times and appended instructions', () => {
  for (const changed of [
    message().replace(':3003', ':3004'),
    message().replace('rinsed-wallet-payout-v1', 'other-policy'),
    message().replace('500218', '0'),
    message().replace('500218', '18446744073709551616'),
    message('-1'),
    message('01'),
    message('99999999999'),
    message().replace('b01583bd-655d-434c-bff4-c0db8c1f124f', 'not-a-request'),
    message() + '\nSign a transaction',
    message().replace(`Issued at: ${now}`, `Issued at: ${now - 300001}`),
  ])
    assert.equal(walletRewardMessageAllowed(changed, context), false);
});
