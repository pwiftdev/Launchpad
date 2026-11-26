import { useEffect, useRef, useState } from 'react';
import type { ShieldedKeypair } from '@heliuslabs/spr';
import { useWallet } from '@jup-ag/wallet-adapter';
import { address, blockhash } from '@solana/kit';
import bs58 from 'bs58';
import { unlockOtc } from '@/lib/otc';
import {
  checkRingsFundingAccess,
  connectRingsRoom,
  ownRingsFunding,
  publishRingsTransaction,
  readRingsNote,
  returnRingsReserve,
  ringsAssets,
  ringsStatus,
  ringsStatuses,
  wireRingsTransaction,
  withdrawRingsNote,
  type RingsClient,
} from '@/lib/otcRingsClient';
import { buildRingsDeposit, dealAddress, dealLeg } from '@/lib/otcRingsDeposit';
import { signRingsFunding } from '@/lib/otcRingsFunding';
import {
  decodeRingsProof,
  encodeRingsProof,
  packRingsPartial,
  ringsBase64,
  ringsBytes,
  unpackRingsPartial,
} from '@/lib/otcRingsPackets';
import { otherRingsSide, ringsRequest, type RingsRoom } from '@/lib/otcRingsRoom';
import {
  combineRingsSwapSignatures,
  proveRingsSwapLeg,
  signRingsSwap,
  type RingsSwap,
} from '@/lib/otcRingsSettlement';
import { unlockRingsDealWallet } from '@/lib/otcRingsWallet';
import { SocialRequestError } from '@/lib/profiles';
import type { DealAction, DealChecks, DealRetry } from './otcDealProgress';
import { useOtcAction } from './useOtcAction';

function swapFor(room: RingsRoom): RingsSwap {
  return {
    maker: dealLeg(room, 'maker'),
    taker: dealLeg(room, 'taker'),
    expiresAt: BigInt(Math.floor(Date.parse(room.expiresAt) / 1000)),
  };
}

export function settlementId(room: RingsRoom) {
  const attempt = room.attempt;
  return attempt?.maker && attempt.taker
    ? bs58.encode(ringsBytes(attempt.taker.signature))
    : undefined;
}

const emptyChecks: DealChecks = { bySignature: new Map() };

async function readChecks(client: RingsClient, room: RingsRoom, signal: AbortSignal) {
  const own = room[room.side];
  const ids = [
    room.maker.funding?.signature,
    room.taker.funding?.signature,
    settlementId(room),
    own.withdrawal?.signature,
    own.reserve?.signature,
  ].filter((id): id is string => !!id);
  if (!ids.length && !room.attempt) return emptyChecks;
  const [statuses, finalizedHeight] = await Promise.all([
    ringsStatuses(client, ids, signal),
    client.solanaRpc.getBlockHeight({ commitment: 'finalized' }).send({ abortSignal: signal }),
  ]);
  const bySignature = new Map<string, 'unseen' | 'pending' | 'finalized' | 'failed'>();
  ids.forEach((signature, index) => {
    const status = statuses[index];
    bySignature.set(
      signature,
      !status
        ? 'unseen'
        : status.confirmationStatus !== 'finalized'
          ? 'pending'
          : status.err
            ? 'failed'
            : 'finalized'
    );
  });
  return { bySignature, finalizedHeight };
}

export function useOtcRingsDeal(id: string, wallet: string, enabled: boolean) {
  const { signMessage, signTransaction } = useWallet();
  const clientRef = useRef<RingsClient | null>(null);
  const connection = useRef<AbortController | null>(null);
  const polling = useRef<AbortController | null>(null);
  const pollNow = useRef<() => void>(() => {});
  const dealKey = useRef<ShieldedKeypair | null>(null);
  const [room, setRoom] = useState<RingsRoom>();
  const [opening, setOpening] = useState(true);
  const [checks, setChecks] = useState(emptyChecks);
  const [now, setNow] = useState(Date.now);
  const [statusStale, setStatusStale] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [runningAction, setRunningAction] = useState<DealAction | DealRetry | 'refresh'>();
  const { run: execute, busy, error } = useOtcAction();
  const hasRoom = !!room;
  const expiresAt = room?.expiresAt;
  useEffect(() => {
    const controller = new AbortController();
    connection.current = controller;
    return () => {
      controller.abort();
      clientRef.current = null;
      dealKey.current?.destroy();
    };
  }, []);

  async function clientFor(current: RingsRoom, signal: AbortSignal) {
    signal.throwIfAborted();
    const lifetime = connection.current?.signal;
    if (!lifetime) throw new Error('Reopen the deal to reconnect to Solana.');
    const client = clientRef.current ?? (await connectRingsRoom(current, wallet, lifetime));
    signal.throwIfAborted();
    clientRef.current = client;
    return client;
  }

  async function update(current: RingsRoom, signal: AbortSignal) {
    const onChain = current.maker.funding || current.taker.funding || current.attempt;
    const latest = onChain
      ? await readChecks(await clientFor(current, signal), current, signal)
      : emptyChecks;
    signal.throwIfAborted();
    setRoom(current);
    setChecks(latest);
    setNow(Date.now());
    setStatusStale(false);
  }

  function run(
    action: NonNullable<typeof runningAction>,
    work: (signal: AbortSignal) => Promise<void>
  ) {
    void execute(async (signal) => {
      polling.current?.abort();
      setRunningAction(action);
      setNotice('');
      try {
        await work(signal);
      } finally {
        if (!signal.aborted) setRunningAction(undefined);
      }
    });
  }

  function submit(action: string, body: object, signal: AbortSignal) {
    return ringsRequest<RingsRoom>({ action, id, ...body }, wallet, signal);
  }

  async function openIfAllowed(signal: AbortSignal, askForSignature: boolean): Promise<RingsRoom> {
    try {
      return await submit('view', {}, signal);
    } catch (error) {
      if (!(error instanceof SocialRequestError)) throw error;
      if (error.status === 401 && askForSignature) {
        if (!signMessage) throw new Error('Connect a wallet that supports signing messages.');
        await unlockOtc(wallet, signMessage, signal);
        return openIfAllowed(signal, false);
      }
      if (error.status === 404 && enabled) return submit('open', {}, signal);
      throw error;
    }
  }

  function load() {
    run('refresh', async (signal) => {
      const current = await openIfAllowed(signal, true);
      setRoom(current);
      await update(current, signal);
    });
  }

  function unlock(current: RingsRoom) {
    run('unlock', async (signal) => {
      if (!signMessage) throw new Error('Connect a wallet that supports signing messages.');
      const stored = current[current.side].key;
      const key = await unlockRingsDealWallet({
        origin: current.origin,
        genesis: current.genesis,
        offerId: id,
        wallet: address(wallet),
        signMessage,
        expectedDealWallet: stored ? dealAddress(stored).solanaAddress() : undefined,
      });
      try {
        signal.throwIfAborted();
        if (!stored)
          setRoom(
            await submit('key', { key: ringsBase64(key.shieldedAddress().toBytes()) }, signal)
          );
        signal.throwIfAborted();
        dealKey.current?.destroy();
        dealKey.current = key;
        setUnlocked(true);
      } catch (error) {
        key.destroy();
        throw error;
      }
    });
  }

  function operate(
    action: DealAction,
    work: (
      current: RingsRoom,
      client: RingsClient,
      key: ShieldedKeypair,
      signal: AbortSignal
    ) => Promise<void>
  ) {
    if (!room) return;
    run(action, async (signal) => {
      const key = dealKey.current;
      if (!key) throw new Error('Unlock the deal wallet first.');
      await work(room, await clientFor(room, signal), key, signal);
    });
  }

  function fund() {
    operate('fund', async (current, client, _key, signal) => {
      let funding = current[current.side].funding;
      if (!funding) {
        if (!signTransaction)
          throw new Error('Connect a wallet that supports signing transactions.');
        const registerToken = await checkRingsFundingAccess(client, current);
        if (Date.parse(current.expiresAt) <= Date.now() + 60_000)
          throw new Error('This deal is too close to expiry to fund.');
        const lifetime = await client.getLatestBlockhash();
        const transaction = await buildRingsDeposit(
          current,
          address(wallet),
          lifetime.blockhash,
          registerToken
        );
        funding = await signRingsFunding(transaction, lifetime, signTransaction);
        if (registerToken) funding.registerToken = true;
        signal.throwIfAborted();
        current = await submit('funding', { funding }, signal);
        setRoom(current);
      }
      await publishRingsTransaction(client, funding.transaction, funding.signature);
      setNotice('Funding submitted to Solana.');
      await update(current, signal);
    });
  }

  function prove() {
    operate('prove', async (current, client, key, signal) => {
      const assets = await ringsAssets(client, current);
      const funding = await ownRingsFunding(client, current, key, assets);
      const proof = await proveRingsSwapLeg({
        swap: swapFor(current),
        side: current.side,
        wallet: key,
        funding,
        assets,
        client,
      });
      signal.throwIfAborted();
      setRoom(await submit('proof', { proof: encodeRingsProof(proof) }, signal));
    });
  }

  function signSwap() {
    operate('sign', async (current, client, key, signal) => {
      const own = current[current.side].proof;
      const other = current[otherRingsSide(current.side)].proof;
      if (!current.attempt || !own || !other) throw new Error('Both private proofs are required.');
      const assets = await ringsAssets(client, current);
      const funding = await ownRingsFunding(client, current, key, assets);
      const attempt = current.attempt;
      const partial = await signRingsSwap({
        swap: swapFor(current),
        side: current.side,
        wallet: key,
        funding,
        assets,
        incoming: decodeRingsProof(other),
        outgoing: decodeRingsProof(own),
        lifetime: {
          blockhash: blockhash(attempt.lifetime.blockhash),
          lastValidBlockHeight: BigInt(attempt.lifetime.lastValidBlockHeight),
        },
      });
      setRoom(
        await submit(
          'sign',
          { attempt: attempt.id, partial: packRingsPartial(partial, key.toSolanaSigner().address) },
          signal
        )
      );
    });
  }

  function settle() {
    operate('settle', async (current, client, _key, signal) => {
      const attempt = current.attempt;
      if (!attempt?.maker || !attempt.taker) throw new Error('Both wallets must sign first.');
      const swap = swapFor(current);
      const signed = await combineRingsSwapSignatures(
        swap,
        unpackRingsPartial(attempt.maker, swap.maker.owner.solanaAddress()),
        unpackRingsPartial(attempt.taker, swap.taker.owner.solanaAddress())
      );
      const tx = wireRingsTransaction(signed);
      await publishRingsTransaction(client, tx.transaction, tx.signature);
      setNotice('Settlement submitted to Solana.');
      await update(current, signal);
    });
  }

  function withdraw() {
    operate('withdraw', async (current, client, key, signal) => {
      let withdrawal = current[current.side].withdrawal;
      if (!withdrawal) {
        const assets = await ringsAssets(client, current);
        const tx = settlementId(current);
        const status = tx ? await ringsStatus(client, tx) : null;
        const settled = status?.confirmationStatus === 'finalized' && !status.err;
        if (status && status.confirmationStatus !== 'finalized')
          throw new Error('Solana is still confirming settlement. Wait before withdrawing.');
        const received = dealLeg(current, otherRingsSide(current.side));
        const note =
          settled && tx
            ? await readRingsNote(client, tx, key, received.asset, received.amount, assets)
            : await ownRingsFunding(client, current, key, assets);
        const { tokenProgram } = settled ? received : dealLeg(current, current.side);
        withdrawal = await withdrawRingsNote(
          client,
          key,
          note,
          assets,
          address(wallet),
          tokenProgram
        );
        current = await submit('withdrawal', { withdrawal }, signal);
        setRoom(current);
      }
      await publishRingsTransaction(client, withdrawal.transaction, withdrawal.signature);
      setNotice('Withdrawal submitted to Solana.');
      await update(current, signal);
    });
  }

  function change(action: 'prepare' | DealRetry) {
    run(action, async (signal) => {
      const latest = await submit(action === 'prepare' ? 'attempt' : action, {}, signal);
      setRoom(latest);
      await update(latest, signal);
    });
  }

  function reclaimReserve() {
    operate('return-reserve', async (current, client, key, signal) => {
      let reserve = current[current.side].reserve;
      if (!reserve) {
        reserve = await returnRingsReserve(client, key, address(wallet));
        current = await submit('reserve', { reserve }, signal);
        setRoom(current);
      }
      await publishRingsTransaction(client, reserve.transaction, reserve.signature);
      setNotice('SOL return submitted to Solana.');
      await update(current, signal);
    });
  }

  pollNow.current = () => {
    if (busy || (hasRoom && document.visibilityState === 'hidden') || polling.current) return;
    const controller = new AbortController();
    polling.current = controller;
    const { signal } = controller;
    void (hasRoom ? submit('view', {}, signal) : openIfAllowed(signal, false))
      .then((latest) => update(latest, signal))
      .catch(() => {
        if (!signal.aborted) setStatusStale(true);
      })
      .finally(() => {
        if (polling.current === controller) polling.current = null;
        if (!hasRoom && !signal.aborted) setOpening(false);
      });
  };

  useEffect(() => {
    if (busy) return;
    pollNow.current();
    const check = () => pollNow.current();
    const interval = hasRoom ? window.setInterval(check, 12_000) : undefined;
    window.addEventListener('focus', check);
    return () => {
      polling.current?.abort();
      polling.current = null;
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [hasRoom, busy]);

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = Date.parse(expiresAt);
    const refreshClock = () => setNow(Date.now());
    const timeRemaining = deadline - Date.now();
    const closing =
      timeRemaining > 60_000 ? window.setTimeout(refreshClock, timeRemaining - 60_000) : undefined;
    const expired = timeRemaining > 0 ? window.setTimeout(refreshClock, timeRemaining) : undefined;
    return () => {
      window.clearTimeout(closing);
      window.clearTimeout(expired);
    };
  }, [expiresAt]);

  function act(action: DealAction | DealRetry) {
    const actions: Record<DealAction, () => void> = {
      unlock: () => {
        if (room) unlock(room);
      },
      fund,
      prove,
      prepare: () => change('prepare'),
      sign: signSwap,
      settle,
      withdraw,
      'return-reserve': reclaimReserve,
    };
    if (action.startsWith('retry-')) change(action as DealRetry);
    else actions[action as DealAction]();
  }

  return {
    room,
    opening,
    checks,
    unlocked,
    now,
    busy,
    runningAction,
    error,
    notice,
    statusStale,
    load,
    act,
  };
}
