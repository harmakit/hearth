import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access,lstat,mkdir,mkdtemp,open,realpath,rm,stat,writeFile } from 'node:fs/promises';
import { basename,delimiter,dirname,isAbsolute,join } from 'node:path';

const execute=promisify(execFile);
const sourceExtension=/\.(?:[cm]?js|jsx|[cm]?ts|tsx|py|go|rs|java|kt|kts|cs|c|cc|cpp|cxx|h|hh|hpp|rb|php|swift|scala|lua|dart|ex|exs|sh|bash|zsh|vue|svelte|gd)$/iu;
const ignored=new Set(['node_modules','vendor','dist','build','target','coverage','__pycache__']);
const maxFiles=1500,maxBytes=12*1024*1024,maxFile=256*1024,maxContext=20_000;
const sourcePath=path=>typeof path==='string'&&path.length<=480&&!/[\\\u0000-\u001f\u007f]/u.test(path)&&
  sourceExtension.test(path)&&path.split('/').every(part=>part&&!part.startsWith('.')&&!ignored.has(part.toLowerCase())&&part.trim()===part);

export function createCodeGraph({storageDir,git,executable,environment=process.env,run=execute}) {
  async function locate(){
    const name=process.platform==='win32'?'codegraph.exe':'codegraph';
    const candidates=executable?[executable]:(environment.PATH??'').split(delimiter).filter(isAbsolute).map(dir=>join(dir,name));
    for(const path of candidates){
      if(!isAbsolute(path)||basename(path)!==name)continue;
      try{
        await access(path,constants.X_OK);
        if((await stat(path)).isFile())return realpath(path);
      }catch{ /* Try the next installed executable. */ }
    }
  }

  async function copySource(root,snapshot,signal){
    const listed=await git(root,['ls-files','--cached','--others','--exclude-standard','-z'],{signal});
    const paths=[...new Set(listed.split('\0').filter(sourcePath))];
    let files=0,bytes=0,partial=false;
    for(const path of paths){
      signal?.throwIfAborted();
      if(files>=maxFiles||bytes>=maxBytes){partial=true;break;}
      const source=join(root,path);
      const info=await lstat(source).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(!info?.isFile()||await realpath(source)!==source)continue;
      if(info.size>maxFile||bytes+info.size>maxBytes){partial=true;continue;}
      const file=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let data;
      try{
        const current=await file.stat();
        if(!current.isFile()||current.size>maxFile||bytes+current.size>maxBytes){partial=true;continue;}
        const buffer=Buffer.alloc(current.size);
        const {bytesRead}=await file.read(buffer,0,buffer.length,0);
        data=buffer.subarray(0,bytesRead);
      }finally{await file.close();}
      const destination=join(snapshot,path);
      await mkdir(dirname(destination),{recursive:true,mode:0o700});
      await writeFile(destination,data,{mode:0o600});
      files++;bytes+=data.length;
    }
    return {files,bytes,partial};
  }

  async function context({root,query,signal}){
    const started=performance.now();
    const finish=(status,fields={})=>({status,durationMs:Math.round(performance.now()-started),...fields});
    if(typeof query!=='string'||!query.trim())return finish('skipped');
    const binary=await locate();
    if(!binary)return finish('unavailable',{reason:'CodeGraph is not installed in PATH.'});
    let scratch;
    try{
      signal?.throwIfAborted();
      const canonical=await realpath(root);
      const top=(await git(canonical,['rev-parse','--show-toplevel'],{signal})).replace(/\r?\n$/u,'');
      if(await realpath(top)!==canonical)return finish('unsupported',{reason:'Not a standalone project or managed worktree.'});
      await mkdir(storageDir,{recursive:true,mode:0o700});
      scratch=await mkdtemp(join(storageDir,'context-'));
      const snapshot=join(scratch,'project');
      await mkdir(snapshot,{mode:0o700});
      const captured=await copySource(canonical,snapshot,signal);
      if(!captured.files)return finish('unsupported',captured);
      const env={PATH:environment.PATH??'',LANG:environment.LANG??'en_US.UTF-8',
        ...(process.platform==='win32'?{SystemRoot:environment.SystemRoot,TEMP:scratch,TMP:scratch}:{}),
        CODEGRAPH_TELEMETRY:'0',DO_NOT_TRACK:'1',CODEGRAPH_NO_DAEMON:'1',CODEGRAPH_NO_UPDATE_CHECK:'1'};
      const options={cwd:snapshot,env,signal,encoding:'utf8',timeout:45_000,maxBuffer:2*1024*1024,windowsHide:true};
      await run(binary,['init',snapshot,'--yes','--local-only'],options);
      const {stdout}=await run(binary,['status',snapshot,'--json'],options);
      const report=JSON.parse(stdout);
      if(!report.nodeCount)return finish('unsupported',{...captured,languages:report.languages??[]});
      const result=await run(binary,['context','--path',snapshot,'--format','markdown','--max-nodes','12','--',query.slice(0,1500)],options);
      const full=String(result.stdout??'').trim();
      const contextText=full.slice(0,maxContext);
      if(!contextText)return finish('empty',captured);
      return finish('used',{...captured,partial:captured.partial||full.length>maxContext,nodes:report.nodeCount,
        languages:report.languages??[],characters:contextText.length,text:contextText});
    }catch(error){
      signal?.throwIfAborted();
      return finish('unavailable',{reason:String(error.message??error).split('\n')[0].slice(0,300)});
    }finally{
      if(scratch)await rm(scratch,{recursive:true,force:true});
    }
  }
  return {context};
}
