import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRecovery} from '../renderer/task-recovery.mjs';

test('previously hidden coach failure remains recoverable from the task after resuming', ()=>{
  const task={id:'coach',studioId:'s',status:'failed',workflowManaged:true,training:{bootstrap:true},failedReviews:3,error:'Упражнение не доказало применимость.'};
  assert.deepEqual(taskRecovery(task,{id:'s',manualPaused:true,wipLimit:5}),{kind:'training',reason:task.error,action:'resume'});
  assert.deepEqual(taskRecovery(task,{id:'s',lifecycle:'idle',wipLimit:5}),{kind:'training',reason:task.error,action:'retry'});
  assert.equal(taskRecovery({...task,status:'running'},{id:'s'}),null);
});

test('auth failures and Git check failures show different next steps', ()=>{
  const task={id:'work',studioId:'s',status:'failed',workflowManaged:true};
  assert.equal(taskRecovery(task,{id:'s',wipLimit:5},[{id:'old',studioId:'s',taskId:'work',status:'failed',action:'authenticate'}]).action,'connection');
  assert.equal(taskRecovery({...task,gitDelivery:{status:'checks-blocked'}},{id:'s',wipLimit:5}).action,'checks');
  assert.equal(taskRecovery(task,{id:'s',projectDetached:true}).action,'project');
});
