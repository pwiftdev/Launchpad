import { useCallback, useSyncExternalStore } from 'react';

// Per-viewer UI preferences (rail expanded, strip mode, watchlist) kept in localStorage.
// Every read and write is guarded: storage can be missing or blocked, and the UI must still work.

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // storage blocked: fall back to memory
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the in-memory copy still drives this session
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** A JSON value persisted per browser, shared live between all components using the same key. */
export function useLocalSetting<T>(key: string, fallback: T): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    (): string | null => read(key),
    (): string | null => null
  );
  let value = fallback;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }
  const set = useCallback((next: T) => write(key, JSON.stringify(next)), [key]);
  return [value, set];
}
