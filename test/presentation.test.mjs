import test from 'node:test';
import assert from 'node:assert/strict';
import { stageMark, progressMark } from '../renderer/presentation.mjs';
import { setCopyLocale } from '../renderer/copy.mjs';

test('stage marks include a shape and label, and progress labels preserve exact counts', () => {
  setCopyLocale('ru');
  assert.match(stageMark('in_progress','В работе'),/data-tone="active".*<svg.*В работе/);
  assert.equal([...progressMark(1,6).matchAll(/<i\b/g)].length,6);
  assert.equal([...progressMark(1,6).matchAll(/data-done/g)].length,1);
  assert.match(progressMark(14,42),/14 из 42/);
  assert.doesNotMatch(progressMark(0,0),/0 из 0/);
  assert.doesNotMatch(stageMark('ready','<b>'),/<b>/);
});
