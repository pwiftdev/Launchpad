import type { NextApiRequest, NextApiResponse } from 'next';
import { liveHub } from './indexer/live';
import type { DisplayEvent } from './indexer/store';

/** Streams are recycled now and then so a stuck proxy connection cannot linger. */
const STREAM_LIFETIME_MS = 10 * 60_000;
const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events for one topic (a mint, or `board`). Each event says what changed;
 * the browser refetches only that. Viewers never cause RPC calls.
 */
export async function streamLive(
  req: NextApiRequest,
  res: NextApiResponse,
  topic: string,
  /** Optional payload for an event, e.g. the changed coin on the board stream; null drops the event. */
  shape: (event: DisplayEvent) => Promise<object | null> = async (event) => ({ kind: event.kind })
) {
  let release: (() => void) | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    release?.();
    if (!res.writableEnded) res.end();
  };
  try {
    release = await liveHub().subscribe(topic, (event) => {
      if (closed || res.writableEnded) return;
      // A failed read sends nothing: telling every viewer to reload would multiply the load that
      // caused it. The browser's fallback timer covers a missed update.
      void shape(event)
        .catch((): null => null)
        .then((data) => {
          if (!data || closed || res.writableEnded) return;
          if (!res.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`)) stop();
        });
    });
    if (req.aborted || res.destroyed) return stop();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded && !res.write(': heartbeat\n\n')) stop();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    expiry = setTimeout(stop, STREAM_LIFETIME_MS);
    expiry.unref?.();
    res.on('close', stop);
    req.on('aborted', stop);
  } catch {
    release?.();
    if (res.headersSent) stop();
    else res.status(503).json({ error: 'Live updates unavailable; polling remains available' });
  }
}
