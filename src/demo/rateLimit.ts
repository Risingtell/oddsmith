/**
 * Simple in-memory sliding-window rate limit for the free public demo route.
 * Single-instance deployment — no shared store needed, and a restart just
 * resets everyone's window, which is fine for a demo endpoint.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

const hits = new Map<string, number[]>();

export function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}
