// Phase 3 — the thin Coread → Morrow bridge.
//
// A human-origin annotation POSTs its context-rich event to Morrow's internal
// endpoint. Morrow owns everything downstream (resident turn, write-back).
// This side is best-effort: a bridge failure must never fail the annotation
// write itself — the comment is already committed and can be re-triggered.

const BRIDGE_URL = process.env.COREAD_MORROW_BRIDGE_URL || '';
const BRIDGE_SECRET = process.env.MORROW_COREAD_BRIDGE_SECRET || '';

export function bridgeConfigured() {
  return Boolean(BRIDGE_URL);
}

export async function postAnnotationEvent(event) {
  if (!BRIDGE_URL) return { ok: false, skipped: 'bridge_not_configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-morrow-request': '1',
        ...(BRIDGE_SECRET ? { 'x-morrow-coread-token': BRIDGE_SECRET } : {}),
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      console.error(`[coread][bridge] Morrow rejected event comment=${event.comment_id} status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[coread][bridge] event delivery failed comment=${event.comment_id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
