import test from 'node:test';
import assert from 'node:assert/strict';
import { todayItems, renderToday, initialWorkspaceView } from '../renderer/today-view.mjs';

const studio = (id, fields = {}) => ({ id, name: id, wipLimit: 5, ...fields });
const item = (id, kind, fields = {}) => ({ id, studioId:'a', kind, title:id, status:'open', createdAt:'2026-11-22T10:30:00Z', ...fields });
const task = (id, fields = {}) => ({ id, studioId:'a', status:'queued', stage:'backlog', dependencies:[], ...fields });

test('Today ranks confirmed dependencies ahead of older available decisions and scopes them to a studio', () => {
  const snapshot = {
    studios:[studio('a'),studio('b'),studio('archive',{archivedAt:'yes'})],
    tasks:[task('coach',{status:'failed',stage:'blocked',workflowManaged:true}),task('next',{dependencies:['coach']}),
      task('final',{dependencies:['next']}),task('foreign',{studioId:'b',dependencies:['coach']}),task('done',{stage:'done',dependencies:['coach']})],
    inbox:[item('approval','acceptance',{createdAt:'2026-11-20T09:00:00Z'}),
      item('retry','error',{taskId:'coach',readAt:'yes',body:'Директор ждёт упражнение.'}),item('archived','question',{studioId:'archive'}),
      item('observed','error'),item('resolved','question',{status:'resolved'})],
  };
  const rows = todayItems(snapshot);
  assert.deepEqual(rows.map(row=>row.id), ['retry','approval']);
  assert.deepEqual(rows[0].affectedTaskIds,['next','final']);
  assert.equal(rows[0].target.studioId,'a');
  assert.equal(snapshot.tasks[1].stage,'backlog');
  assert.equal(initialWorkspaceView(snapshot),'today');
  assert.equal(initialWorkspaceView({...snapshot,inbox:[]}),'workspace');
  const html=renderToday({...snapshot,appLocale:'ru'});
  assert.match(html,/Директор ждёт упражнение/);
  assert.match(html,/Повторить запуск/);
});

test('Today waits for stopped processes and deduplicates linked decisions', () => {
  const snapshot = {
    studios:[studio('a')],
    attempts:[{id:'hold',studioId:'a',status:'reconcile',processActive:true}],
    meetings:[{id:'meeting',studioId:'a',title:'Review',stage:'owner_review'}],
    rosterProposals:[{id:'r',studioId:'a',status:'pending',reason:'Candidate'}],
    phases:[{id:'p',studioId:'a',title:'Phase',transition:{id:'tr',status:'pending'}}],
    inbox:[item('reconcile','reconcile',{attemptId:'hold'}),item('m','meeting',{meetingId:'meeting'}),item('roster','roster',{proposalId:'r'})],
  };
  assert.deepEqual(todayItems(snapshot).map(row=>row.id),['m','roster','tr']);
  snapshot.attempts[0].processActive=false;
  assert.ok(todayItems(snapshot).some(row=>row.id==='reconcile'));
  assert.doesNotMatch(renderToday({...snapshot,studios:[studio('a',{name:'<button id="injected">',archivedAt:'yes'})]}),/id="injected"/);
});
