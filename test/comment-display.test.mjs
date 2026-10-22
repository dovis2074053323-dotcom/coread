import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { humanDisplayName, formatCommentTime } from '../web/comment-display.mjs';
import { unreadReplies } from '../web/reply-poll.mjs';

const readerSource = readFileSync(new URL('../web/StudyApp.tsx', import.meta.url), 'utf8');

test('missing or legacy human nickname displays as vv without overwriting custom names', () => {
  assert.equal(humanDisplayName(null), 'vv');
  assert.equal(humanDisplayName('human'), 'vv');
  assert.equal(humanDisplayName(' HUMAN '), 'vv');
  assert.equal(humanDisplayName('vv'), 'vv');
  assert.equal(humanDisplayName('小鱼'), '小鱼');
  assert.match(readerSource, /humanDisplayName\(localStorage\.getItem\('coread-human-name'\)\)/);
  assert.match(readerSource, /lower === 'human' \|\| lower === 'vv'/);
});

test('SQLite UTC and ISO UTC comment timestamps display in local time', () => {
  const oldZone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Singapore';
    assert.equal(formatCommentTime('2026-10-22 05:50:00'), '10-22 13:50');
    assert.equal(formatCommentTime('2026-10-22T05:50:00.000Z'), '10-22 13:50');
    assert.equal(formatCommentTime('2026-10-21 18:30:00'), '10-22 02:30');
    assert.equal(formatCommentTime('2026-10-22T13:50:00+08:00'), '10-22 13:50');
    assert.equal(formatCommentTime('invalid'), '');
  } finally {
    if (oldZone === undefined) delete process.env.TZ;
    else process.env.TZ = oldZone;
  }
  assert.match(readerSource, /formatCommentTime\(cmt\.created_at\)/);
  assert.doesNotMatch(readerSource, /cmt\.created_at\?\.slice\(5, 16\)/);
});

test('legacy human and vv replies are not misidentified as AI replies after nickname recovery', () => {
  const notices = [
    { id: 2, from_who: 'human' },
    { id: 3, from_who: 'vv' },
    { id: 4, from_who: 'claude-code' },
  ];
  assert.deepEqual(unreadReplies(notices, 1, 'vv').map(item => item.id), [4]);
  assert.deepEqual(unreadReplies(notices, 1, '小鱼').map(item => item.id), [4]);
});
