import { createHash,randomUUID } from 'node:crypto';
import { lstat,mkdir,readFile,readdir,readlink,realpath,rename,rm,symlink,writeFile } from 'node:fs/promises';
import { dirname,join,posix } from 'node:path';
import { git,hasProjectGitDirectory } from './git-worktrees.mjs';

const manifestPath='.hearth/state/managed-files.json';
const settingsPath='.hearth/studio.json';
const ignored=['/.hearth/state/','/.hearth/worktrees/','/.claude/agent-memory/','/.claude/agent-memory-local/'];
const namePattern=/^[a-z][a-z0-9-]{0,62}$/u;
const notFound=error=>error.code==='ENOENT';
const json=value=>JSON.stringify(value,null,2)+'\n';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function nameFor(value) {
  if(typeof value!=='string' || !namePattern.test(value))throw new Error('Имя роли или навыка должно быть в формате slug.');
  return value;
}

function relativePath(value) {
  if(typeof value!=='string' || !value || value.includes('\\') || value.split('/').some(part=>!part || part==='.' || part==='..' || part.toLowerCase()==='.git' || /[:*?"<>|\p{Cc}]/u.test(part))){
    throw new Error('Недопустимый путь к файлу студии.');
  }
  return value;
}

async function checkParents(root,path,{create=false}={}) {
  const parts=relativePath(path).split('/');
  let parent=root;
  for(const part of parts.slice(0,-1)){
    parent=join(parent,part);
    if(create)await mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(parent).catch(error=>{if(!notFound(error))throw error;});
    if(!info)return false;
    if(!info.isDirectory() || info.isSymbolicLink())throw new Error(`Путь студии недоступен: ${path}`);
  }
  return true;
}

async function readEntry(root,path) {
  if(!await checkParents(root,path))return;
  const full=join(root,path);
  const info=await lstat(full).catch(error=>{if(!notFound(error))throw error;});
  if(!info)return;
  if(info.isSymbolicLink())return {link:await readlink(full)};
  if(!info.isFile() || info.nlink!==1)throw new Error(`Файл студии недоступен: ${path}`);
  return {text:await readFile(full,'utf8')};
}

async function atomicWrite(root,path,entry) {
  await checkParents(root,path,{create:true});
  const target=join(root,path);
  const temp=join(dirname(target),'.hearth-write-'+randomUUID());
  try {
    if(entry.link)await symlink(entry.link,temp,'dir');
    else await writeFile(temp,entry.text,{flag:'wx',mode:0o600});
    await rename(temp,target);
  } finally { await rm(temp,{force:true}); }
}

function markdown(name,description,instructions,skills) {
  return ['---','name: '+JSON.stringify(name),'description: '+JSON.stringify(description),
    ...(skills?.length?['skills: '+JSON.stringify(skills)]:[]),'---','',instructions,''].join('\n');
}

function desiredFiles({settings,roles=[],skills=[]},useSymlinks) {
  const entries=new Map();
  const add=(path,text)=>{
    if(entries.has(path))throw new Error(`Повторяется путь файла студии: ${path}`);
    entries.set(path,{text});
  };
  add(settingsPath,json({schemaVersion:1,...settings}));
  for(const skill of skills){
    const name=nameFor(skill.name);
    if(typeof skill.description!=='string' || !skill.description.trim())throw new Error(`У навыка «${name}» нет описания применения.`);
    const files={...skill.files,'SKILL.md':markdown(name,skill.description,skill.instructions)};
    for(const [path,text] of Object.entries(files)){
      add('.agents/skills/'+name+'/'+relativePath(path),text);
      if(!useSymlinks)add('.claude/skills/'+name+'/'+path,text);
    }
    if(useSymlinks)entries.set('.claude/skills/'+name,{link:'../../.agents/skills/'+name});
  }
  for(const role of roles){
    const name=nameFor(role.name);
    const requiredSkills=(role.requiredSkills??[]).map(nameFor);
    const shared=markdown(name,role.description,role.instructions,requiredSkills);
    add(`.hearth/roles/${name}.md`,shared);
    add(`.claude/agents/${name}.md`,shared);
    const instructions=[role.instructions,...(requiredSkills.length?
      ['Required project skills: '+requiredSkills.map(name=>'$'+name).join(', ')+'.']:[])].join('\n\n');
    add(`.codex/agents/${name}.toml`,[
      'name = '+JSON.stringify(name),'description = '+JSON.stringify(role.description),
      'developer_instructions = '+JSON.stringify(instructions),
    ].join('\n')+'\n');
  }
  return entries;
}

function roleData(text) {
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if(!match)throw new Error('Не удалось прочитать определение роли Hearth.');
  const values=Object.fromEntries(match[1].split(/\r?\n/u).map(line=>{
    const separator=line.indexOf(':');
    return [line.slice(0,separator),JSON.parse(line.slice(separator+1))];
  }));
  return {name:values.name,description:values.description,requiredSkills:values.skills??[],instructions:match[2].trim()};
}

export function createProjectStudioFiles({validateRoot=realpath,useSymlinks=process.platform!=='win32'}={}) {
  const running=new Map();
  async function inspect(directory){
    const root=await validateRoot(directory);
    const data=await readEntry(root,settingsPath);
    if(data && !data.text)throw new Error('Файл настроек Hearth должен быть обычным файлом.');
    const settings=data?JSON.parse(data.text):undefined;
    if(settings && (settings.schemaVersion!==1 || typeof settings.id!=='string' || typeof settings.name!=='string')){
      throw new Error('Неизвестный формат настроек студии.');
    }
    return {root,settings,revision:data && digest(data)};
  }

  async function publishFiles(directory,input,{expectedRevision}={}){
    const {root,revision}=await inspect(directory);
    if(expectedRevision!==undefined && revision!==expectedRevision)throw new Error('Настройки студии изменились.');
    const entries=desiredFiles(input,useSymlinks);
    const hasGit=await hasProjectGitDirectory(root);
    if(hasGit){
      const tracked=(await git(root,['ls-files','-z','--',...ignored.map(path=>path.slice(1))])).split('\0').filter(Boolean);
      if(tracked.length)throw new Error('Приватные файлы уже добавлены в Git: '+tracked.slice(0,6).join(', '));
    }
    const manifest=await readEntry(root,manifestPath);
    if(manifest && !manifest.text)throw new Error('Реестр управляемых файлов должен быть обычным файлом.');
    const previous=manifest?JSON.parse(manifest.text):{};
    const currentIgnore=await readEntry(root,'.gitignore');
    if(currentIgnore?.link)throw new Error('Существующий .gitignore должен быть обычным файлом.');
    // Attaching the studio must not dirty a tracked ignore file on its target branch.
    const trackedIgnore=hasGit && Boolean(await git(root,['ls-files','-z','--','.gitignore']));
    const ignoreRoot=trackedIgnore?join(root,'.git'):root;
    const ignorePath=trackedIgnore?'info/exclude':'.gitignore';
    const localIgnore=trackedIgnore?await readEntry(ignoreRoot,ignorePath):currentIgnore;
    if(localIgnore?.link)throw new Error('Список исключений Git должен быть обычным файлом.');
    const lines=new Set([...(currentIgnore?.text.split(/\r?\n/u)??[]),...(localIgnore?.text.split(/\r?\n/u)??[])]);
    const additions=ignored.filter(path=>!lines.has(path));
    for(const [path,entry] of entries){
      const current=await readEntry(root,path);
      if(current && digest(current)!==digest(entry) && previous[path]!==digest(current)){
        throw new Error(`Файл изменён вне Hearth: ${path}`);
      }
    }
    for(const [path,entry] of entries){
      const current=await readEntry(root,path);
      if(!current || digest(current)!==digest(entry))await atomicWrite(root,path,entry);
    }
    if(additions.length){
      const original=localIgnore?.text ?? '';
      await atomicWrite(ignoreRoot,ignorePath,{text:original+(original&&!original.endsWith('\n')?'\n':'')+
        ['# Hearth Studio',...additions,''].join('\n')});
    }
    const next={...previous,...Object.fromEntries([...entries].map(([path,entry])=>[path,digest(entry)]))};
    if(JSON.stringify(next)!==JSON.stringify(previous))await atomicWrite(root,manifestPath,{text:json(next)});
    return inspect(root);
  }

  async function publish(directory,input,options) {
    const root=await validateRoot(directory);
    const prior=running.get(root)??Promise.resolve();
    const operation=prior.catch(()=>{}).then(()=>publishFiles(root,input,options));
    running.set(root,operation);
    try {return await operation;} finally {if(running.get(root)===operation)running.delete(root);}
  }

  async function resolveRole(directory,name,runtime) {
    const root=await validateRoot(directory);
    nameFor(name);
    const source=await readEntry(root,`.hearth/roles/${name}.md`);
    if(!source?.text)throw new Error(`Роль «${name}» отсутствует в папке проекта.`);
    const data=roleData(source.text);
    const definitionPath=runtime==='claude'?`.claude/agents/${name}.md`:`.codex/agents/${name}.toml`;
    const requiredSkills=data.requiredSkills.map(skill=>({name:nameFor(skill),path:posix.join('.agents','skills',skill,'SKILL.md')}));
    return {...data,definitionPath,requiredSkills};
  }
  async function prepareRole(project,workspace,name,runtime){
    if(project===workspace)return {role:await resolveRole(project,name,runtime),release:async()=>{}};
    const role=await resolveRole(project,name,runtime);
    const manifest=JSON.parse((await readEntry(project,manifestPath)).text);
    const required=new Set([role.definitionPath,...Object.keys(manifest).filter(path=>role.requiredSkills.some(skill=>
      path.startsWith('.agents/skills/'+skill.name+'/') || path==='.claude/skills/'+skill.name ||
      path.startsWith('.claude/skills/'+skill.name+'/')))]);
    const temporary=[];
    async function release(){
      for(const {path,checksum} of temporary.reverse()){
        const current=await readEntry(workspace,path);
        if(!current)continue;
        if(digest(current)!==checksum)throw new Error(`Исполнитель изменил служебный файл роли: ${path}`);
        await rm(join(workspace,path));
      }
    }
    try {
      for(const path of required){
        const original=await readEntry(project,path);
        if(!original || digest(original)!==manifest[path])throw new Error(`Файл роли изменился: ${path}`);
        const existing=await readEntry(workspace,path);
        if(existing && digest(existing)!==digest(original))throw new Error(`Версия файла роли на ветке отличается: ${path}`);
        if(!existing){
          await atomicWrite(workspace,path,original);
          temporary.push({path,checksum:manifest[path]});
        }
      }
      return {role,release};
    } catch(error){await release();throw error;}
  }

  async function readRecipe(directory,names){
    const {root}=await inspect(directory);
    const roles=[];
    const required=new Set();
    for(const name of names.map(nameFor)){
      const entry=await readEntry(root,`.hearth/roles/${name}.md`);
      if(!entry?.text)throw new Error(`В папке нет инструкции роли «${name}».`);
      const role=roleData(entry.text);
      if(role.name!==name)throw new Error(`Некорректное имя роли: ${name}.`);
      roles.push(role);
      for(const skill of role.requiredSkills)required.add(nameFor(skill));
    }
    const skills=[];
    let fileCount=0;
    async function collect(folder,subfolder=''){
      const files={};
      const entries=await readdir(join(root,folder,subfolder),{withFileTypes:true});
      for(const entry of entries){
        const name=relativePath(posix.join(subfolder,entry.name));
        if(++fileCount>240)throw new Error('Слишком много файлов в навыках студии.');
        if(entry.isDirectory())Object.assign(files,await collect(folder,name));
        else {
          if(!entry.isFile())throw new Error(`Навык содержит неподдерживаемую ссылку: ${name}`);
          const file=await readEntry(root,folder+'/'+name);
          if(typeof file?.text!=='string' || Buffer.byteLength(file.text)>128*1024)throw new Error(`Недоступен файл навыка: ${name}`);
          files[name]=file.text;
        }
      }
      return files;
    }
    for(const name of required){
      const folder='.agents/skills/'+name;
      if(!await checkParents(root,folder+'/SKILL.md'))throw new Error(`Навык «${name}» недоступен.`);
      const files=await collect(folder);
      if(!files['SKILL.md'])throw new Error(`Навык «${name}» недоступен.`);
      const meta=roleData(files['SKILL.md']);
      delete files['SKILL.md'];
      if(meta.name!==name)throw new Error(`Некорректное имя навыка: ${name}.`);
      skills.push({name,description:meta.description,instructions:meta.instructions,files});
    }
    return {roles,skills};
  }
  return {inspect,publish,resolveRole,prepareRole,readRecipe};
}
