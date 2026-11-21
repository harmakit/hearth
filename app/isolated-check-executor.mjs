import { spawn } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const maxBytes=16*1024*1024;
const safeName=/^(?!\.\.?$)(?!\.git$)[^\\/:<>*"|?\u0000-\u001f]+$/iu;

async function snapshot(root,signal) {
  const files=[];
  let bytes=0;
  async function visit(folder,prefix) {
    for(const name of await readdir(folder)) {
      signal.throwIfAborted();
      if(name.toLowerCase()==='.git')continue;
      if(!safeName.test(name))throw Error('Unsupported worker snapshot path');
      const relative=prefix+name, filename=join(folder,name);
      const info=await lstat(filename);
      if(await realpath(filename)!==filename || (!info.isDirectory() && (!info.isFile() || info.nlink!==1)))throw Error('Worker snapshot accepts only ordinary files and directories');
      if(info.isDirectory())await visit(filename,relative+'/');
      else {
        if(info.size+bytes>maxBytes || files.length>=4000)throw Error('Worker snapshot is too large');
        const handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
        let buffer;
        try {
          const opened=await handle.stat();
          if(opened.dev!==info.dev || opened.ino!==info.ino || !opened.isFile() || opened.size!==info.size)throw Error('Worker snapshot changed');
          buffer=Buffer.alloc(info.size);
          const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
          const final=await handle.stat();
          if(bytesRead!==buffer.length || final.size!==opened.size || final.mtimeMs!==opened.mtimeMs || final.ctimeMs!==opened.ctimeMs)throw Error('Worker snapshot changed');
        } finally {await handle.close();}
        bytes+=buffer.length;
        files.push({path:relative,data:buffer.toString('base64')});
      }
    }
  }
  await visit(await realpath(root),'');
  return files;
}

export function createSshCheckExecutor(host,{ssh='ssh', config}={}) {
  if(!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(host))throw Error('Invalid worker SSH host');
  if(config!==undefined && !isAbsolute(config))throw Error('Worker SSH config must use an absolute path');
  return async ({root,command,args,network,signal,evidenceGlobs})=>{
    if(network || evidenceGlobs?.length)throw Error('The isolated check worker currently supports offline checks with log output.');
    const files=await snapshot(root,signal);
    signal.throwIfAborted();
    const answer=await new Promise((resolve,reject)=>{
      const configArgs=config ? ['-F',config] : [];
      const child=spawn(ssh,[...configArgs,'-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ClearAllForwardings=yes','--',host,'hearth-check-worker'],{shell:false,windowsHide:true,signal,stdio:['pipe','pipe','ignore']});
      const parts=[];
      let size=0;
      child.once('error',reject);
      child.stdin.on('error',reject);
      child.stdout.on('data',chunk=>{
        size+=chunk.length;
        if(size>256*1024){child.kill();reject(Error('Worker response was too large'));return;}
        parts.push(chunk);
      });
      child.once('close',code=>{
        if(code!==0){reject(Error('Isolated check worker unavailable'));return;}
        try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch(error){reject(error);}
      });
      child.stdin.end(JSON.stringify({version:1,command,args,files}));
    });
    if(answer.version!==1 || !Number.isInteger(answer.code) || answer.code<0 || answer.code>255 || typeof answer.output!=='string')throw Error('Invalid isolated check response');
    return {code:answer.code,output:Buffer.from(answer.output,'utf8')};
  };
}
