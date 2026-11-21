import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const pieces=[];
let size=0;
for await(const chunk of process.stdin) {
  size+=chunk.length;
  if(size>24*1024*1024)throw Error('Oversize worker request');
  pieces.push(chunk);
}
const request=JSON.parse(Buffer.concat(pieces).toString('utf8'));
if(request.version!==1 || !/^[a-z0-9][a-z0-9_.+-]{0,127}$/iu.test(request.command) ||
  !Array.isArray(request.args) || request.args.some(a=>typeof a!=='string'||a.includes('\0')) ||
  !Array.isArray(request.files) || request.files.length>4000)throw Error('Invalid worker request');
const cwd='/work/project';
await mkdir(cwd,{recursive:true});
let bytes=0;
for(const file of request.files) {
  if(typeof file.path!=='string' || !file.path.split('/').every(p=>/^(?!\.\.?$)(?!\.git$)[^\\/:<>*"|?\u0000-\u001f]+$/iu.test(p)))throw Error('Invalid worker file path');
  const content=Buffer.from(file.data,'base64');
  bytes+=content.length;
  if(bytes>16*1024*1024 || content.toString('base64')!==file.data)throw Error('Invalid worker file bytes');
  const dest=join(cwd,file.path);
  await mkdir(dirname(dest),{recursive:true});
  await writeFile(dest,content,{flag:'wx'});
}
const result=spawnSync(request.command,request.args,{cwd,shell:false,encoding:'utf8',timeout:120000,maxBuffer:48*1024,
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',TMPDIR:'/work',LANG:'C.UTF-8'}});
if(result.error || result.signal)throw Error('Worker command did not exit normally',{cause:result.error});
const output=Buffer.from((result.stdout??'')+(result.stderr??'')).subarray(0,48*1024).toString('utf8');
process.stdout.write(JSON.stringify({version:1,code:result.status,output}));
