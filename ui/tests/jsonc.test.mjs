import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonc, stripJsonComments } from '../src/utils/jsonc.ts';

test('a URL inside a string survives (the bug: `//` in https:// truncated the line)', () => {
  const text = '{"meta": {"description": "see https://example.com/x for the recipe"}}';
  assert.deepEqual(parseJsonc(text), { meta: { description: 'see https://example.com/x for the recipe' } });
});

test('line and block comments outside strings are removed', () => {
  const text = [
    '{',
    '  // rank per the guide',
    '  "linear": 32, /* alpha follows */ "linear_alpha": 32,',
    '  "path": "C:/models/x" // trailing comment after a string with slashes',
    '}',
  ].join('\n');
  assert.deepEqual(parseJsonc(text), { linear: 32, linear_alpha: 32, path: 'C:/models/x' });
});

test('escaped quotes inside strings do not end the string early', () => {
  const text = '{"prompt": "a \\"quoted\\" // not a comment", "n": 1}';
  assert.deepEqual(parseJsonc(text), { prompt: 'a "quoted" // not a comment', n: 1 });
});

test('newlines are preserved so a parse error still points at the right line', () => {
  const text = '{\n/* multi\nline */\n"a": 1\n}';
  assert.equal(stripJsonComments(text).split('\n').length, text.split('\n').length);
});

test('plain JSON passes through unchanged', () => {
  const text = JSON.stringify({ a: [1, 2, { b: 'c/d' }] }, null, 2);
  assert.equal(stripJsonComments(text), text);
});
