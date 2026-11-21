import assert from 'node:assert/strict';
import test from 'node:test';
import {createSshCheckExecutor} from '../app/isolated-check-executor.mjs';

test('offline worker refuses unsafe destination and unsupported evidence requests before dispatch',async()=>{
  assert.throws(()=>createSshCheckExecutor('-oProxyCommand'),/host/);
  assert.throws(()=>createSshCheckExecutor('host;cmd'),/host/);
  const execute=createSshCheckExecutor('qa@worker.example');
  await assert.rejects(execute({root:'/unused',network:true,signal:new AbortController().signal}),/offline/);
  await assert.rejects(execute({root:'/unused',evidenceGlobs:['**/*.txt'],signal:new AbortController().signal}),/log output/);
});
