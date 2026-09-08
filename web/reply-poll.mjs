// Keep the response-time last-seen comparison independent from React so a
// delayed poll can be tested deterministically.
export function unreadReplies(replies, lastSeen, humanName) {
  const seen = Number(lastSeen) || 0;
  const human = String(humanName || '').toLowerCase();
  return (Array.isArray(replies) ? replies : []).filter((reply) => (
    Number(reply?.id) > seen
      && String(reply?.from_who || '').toLowerCase() !== human
  ));
}
