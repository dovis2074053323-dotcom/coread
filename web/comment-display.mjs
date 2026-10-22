// Keep legacy author labels and SQLite UTC timestamps consistent in the reader.
export function humanDisplayName(savedName) {
  const name = String(savedName || '').trim();
  return !name || name.toLowerCase() === 'human' ? 'vv' : name;
}

export function formatCommentTime(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.trim()) return '';
  const normalized = timestamp.trim().replace(' ', 'T');
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
