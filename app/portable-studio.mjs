import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

const settingsKeys=['id','name','brief','language','languageMode','projectLanguage','director','allowed','allowedMode',
  'approveSprints','skillMinStars','schedule','debtPolicy','groomingPolicy','wipLimit','staffing','sprintReview','projectGit'];
const field=(record,keys)=>Object.fromEntries(keys.filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));
const skillName=record=>'skill-'+createHash('sha256').update(record.id).digest('hex').slice(0,14);
export const nativeRoleName=agent=>agent?'role-'+createHash('sha256').update(agent.id).digest('hex').slice(0,14):'director';

export function portableModel(state,studio){
  const available=state.skills.filter(entry=>entry.studioId===studio.id && entry.redistributable===true);
  const local=state.customSkills.filter(entry=>entry.studioId===studio.id && entry.content && entry.title)
    .filter(entry=>{
      const latest=state.knowledgeEvents?.findLast(event=>event.studioId===studio.id && event.kind==='customSkill'
        && event.agentId===entry.agentId && event.key===entry.key);
      return !latest || latest.versionId===entry.id;
    });
  const bind=agent=>[...available.filter(skill=>agent.skillIds?.includes(skill.id)),...local.filter(skill=>skill.agentId===agent.id)].map(skillName);
  const skills=[...available,...local].map(skill=>({
    name:skillName(skill),description:skill.description||skill.title||'Use for the assigned role when this procedure applies.',
    instructions:skill.content,files:{...skill.files,...(skill.redistributable?{
      'SOURCE.md':`# Source\n\n${skill.url}\n\nRevision: ${skill.commit}\n\nLicense: ${skill.license}\n`,
    }:{})},
  }));
  const imported=new Map(studio.recipe?.roles.map(role=>[role.name,role])??[]);
  const roles=[imported.get('director')??{name:'director',description:'Direct this studio.',instructions:'Coordinate this studio using the recorded plan and owner decisions.'}];
  for(const agent of studio.agents.filter(agent=>agent.rosterStatus!=='retired')){
    const display=agent.roleTitle||agent.name||agent.role;
    const description=agent.description||display||'Studio specialist.';
    const name=nativeRoleName(agent);
    const inherited=imported.get(name);
    roles.push(inherited && !agent.trainingGuide?{...inherited,requiredSkills:[...new Set([...inherited.requiredSkills,...bind(agent)])]}:
      {name,description,instructions:[`# ${display}`,description,agent.trainingGuide].filter(Boolean).join('\n\n'),requiredSkills:bind(agent)});
  }
  const settings=field(studio,settingsKeys);
  settings.agents=studio.agents.filter(agent=>agent.rosterStatus!=='retired').map(agent=>
    field(agent,['id','key','name','role','roleTitle','description','systemRole','mode','runtime','model','effort']));
  return {settings,roles,skills:[...(studio.recipe?.skills??[]),...skills]};
}

export function createPortableStudioManager({service,files,worktrees,validateRoot,migrateEvidence}) {
  const rootFor=id=>service.snapshot().studios.find(studio=>studio.id===id);
  const published=new Map();
  async function publish(studio){
    const model=portableModel(service.snapshot(),studio);
    const version=JSON.stringify(model);
    if(published.get(studio.root)?.version===version)return published.get(studio.root).result;
    const result=files.publish(studio.root,model);
    published.set(studio.root,{version,result});
    try {return await result;} catch(error){
      if(published.get(studio.root)?.result===result)published.delete(studio.root);
      throw error;
    }
  }

  async function create(studio){
    await publish(studio);
    return service.migrateStudioStorage({studioId:studio.id,root:studio.root});
  }

  async function assertEmptyRecipe(root){
    if((await files.inspect(root)).settings)throw new Error('В папке уже есть студия. Выберите «Открыть папку студии».');
  }

  async function migrate({studioId,root}){
    const studio=rootFor(studioId);
    if(!studio || await validateRoot(studio.root)!==root)throw new Error('Выберите исходную папку студии.');
    if(studio.activeAttempts)throw new Error('Дождитесь завершения активных запусков.');
    if(!studio.portable)service.pauseForStudioCopy({studioId});
    await publish(rootFor(studioId));
    await migrateEvidence?.(studio);
    if(studio.projectGit?.enabled)await worktrees.migrate(studio);
    const result=await service.migrateStudioStorage({studioId,root});
    return result;
  }

  async function inspect({root}){
    const {settings}=await files.inspect(root);
    if(!settings)throw new Error('В папке нет настроек Hearth Studio.');
    return {name:settings.name,root,otherRoot:rootFor(settings.id)?.root};
  }

  async function open({root,replaceRoot}){
    const {settings}=await files.inspect(root);
    if(!settings)throw new Error('В папке нет настроек Hearth Studio.');
    const exists=await lstat(join(root,'.hearth','state','studio.sqlite3')).then(()=>true,error=>{
      if(error.code==='ENOENT')return false;
      throw error;
    });
    if(exists)return service.openStudioStorage({studioId:settings.id,root,replaceRoot});
    const recipe=await files.readRecipe(root,['director',...(settings.agents??[]).map(nativeRoleName)]);
    return service.openStudioRecipe({settings,root,recipe});
  }

  async function prepare({studioId}){
    const studio=rootFor(studioId);
    if(!studio?.portable)throw new Error('Сначала перенесите данные в папку студии.');
    service.pauseForStudioCopy({studioId});
    if(rootFor(studioId).activeAttempts)throw new Error('Дождитесь завершения активных запусков и повторите подготовку.');
    await publish(rootFor(studioId));
    return {ready:true,root:studio.root};
  }
  return {create,publish,migrate,inspect,open,prepare,assertEmptyRecipe};
}
