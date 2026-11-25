import assert from 'node:assert/strict';
import test from 'node:test';
import { delimiter } from 'node:path';
import { macToolPath } from '../app/native-tool-path.cjs';

test('desktop PATH keeps explicit tools first and finds unlinked versioned Homebrew Node kegs', () => {
  const readDirectory = root => {
    if (root === '/opt/homebrew/opt') return ['node@22', 'node@24', 'node', 'node@not-a-version', 'other@25'];
    if (root === '/usr/local/opt') throw Object.assign(new Error('Missing'), {code:'ENOENT'});
    throw new Error('Unexpected path: ' + root);
  };
  assert.deepEqual(macToolPath(['/custom/bin','/opt/homebrew/bin'].join(delimiter), '/example-owner', readDirectory).split(delimiter), [
    '/custom/bin', '/opt/homebrew/bin', '/example-owner/.local/bin', '/usr/local/bin', '/usr/bin', '/bin',
    '/opt/homebrew/opt/node/bin', '/opt/homebrew/opt/node@24/bin', '/opt/homebrew/opt/node@22/bin',
  ]);
});
