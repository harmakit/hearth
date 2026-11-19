import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectorHistory, membersOfEpic } from '../renderer/inspector.mjs';

test('inspecting an epic and returning restores the previously selected task and reading position', () => {
  const history = createInspectorHistory();
  history.visit('s','task','a'); history.savePosition(170);
  history.visit('s','epic','e');
  assert.deepEqual(history.back(), {studioId:'s',kind:'task',id:'a',scroll:170});
  history.visit('other','task','a');
  assert.equal(history.back(), undefined);
});

test('epic includes inherited story members exactly once and excludes other studios', () => {
  const result = membersOfEpic({id:'e',studioId:'s'},
    [{id:'story',studioId:'s',epicId:'e'}],
    [{id:'one',studioId:'s',storyId:'story',epicId:'e'},{id:'two',studioId:'s',storyId:'story'},{id:'foreign',studioId:'b',epicId:'e'}]);
  assert.deepEqual(result.map(t=>t.id), ['one','two']);
});
