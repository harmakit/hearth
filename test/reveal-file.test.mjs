import assert from 'node:assert/strict';
import test from 'node:test';
import {revealFile} from '../app/reveal-file.cjs';
import {join,dirname} from 'node:path';
for (const platform of ['darwin','win32','linux']) {
  test('desktop reveal and folder fallback for '+platform,async()=>{
    const path=join('Studio','Глава 1.txt'), calls=[];
    const shell={showItemInFolder:f=>calls.push(f),openPath:async f=>{calls.push(f);return '';}};
    assert.equal((await revealFile(shell,path,{platform,sessionBus:'test'})).parentOpened,false);
    shell.showItemInFolder=()=>{throw new Error('not available');};
    const fallback=await revealFile(shell,path,{platform,sessionBus:''});
    assert.equal(fallback.name,'Глава 1.txt');assert.equal(fallback.parentOpened,true);
    assert.deepEqual(calls,[path,dirname(path)]);
  });
}
