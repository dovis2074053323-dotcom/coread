import assert from 'node:assert/strict';
import test from 'node:test';
import { smartSplit } from '../lib/epub.mjs';

test('smartSplit restores ordinary one-paragraph-per-line Chinese text', () => {
  const input = [
    '第一段没有空行，但它有一个完整的句号。',
    '第二段同样是自然段，只使用一次换行。',
    '第三段也应该独立保存，批注才能锚定到正确段落。',
  ].join('\n');
  assert.deepEqual(smartSplit(input), input.split('\n'));
});

test('smartSplit rejoins fixed-width soft wraps instead of treating every line as a paragraph', () => {
  const input = [
    '这是一段被编辑器按照固定宽度自动换行的普通文本，当前这一行还没有结束',
    '下一行只是同一个自然段的延续，所以导入时需要把它们重新连接起来',
    '直到最后一行出现完整句号，才算自然段结束。',
  ].join('\n');
  assert.deepEqual(smartSplit(input), [input.replaceAll('\n', '')]);
});

test('smartSplit keeps Markdown structure and explicit blank-line boundaries', () => {
  const input = '# 标题\n正文第一句。\n正文第二句。\n\n- 列表一\n- 列表二';
  assert.deepEqual(smartSplit(input), ['# 标题', '正文第一句。', '正文第二句。', '- 列表一', '- 列表二']);
});

test('smartSplit preserves short verse lines inside one pre-wrapped paragraph', () => {
  const input = '月亮落在杯沿\n风从书页经过\n灯还没有睡';
  assert.deepEqual(smartSplit(input), [input]);
});
