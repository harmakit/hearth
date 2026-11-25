import { randomUUID } from 'node:crypto';

const day = 24 * 60 * 60 * 1000;
const retryDelay = 15 * 60 * 1000;
const sha = /^[a-f0-9]{40}$/;
const sameSkill = (left,right) => left.repo?.toLowerCase()===right.repo?.toLowerCase() && left.path===right.path;
const currentIds = studio => new Set(studio.agents.filter(agent=>agent.rosterStatus!=='retired').flatMap(agent=>agent.skillIds??[]));

export function createSkillVersions({list,read,insert,update,transaction,changed,checkVersion,clock,activeCount,wake,isClosed}) {
  const running = new Map();
  const checksFor = studioId => list('skillChecks').filter(row=>row.studioId===studioId);
  const studioFor = studioId => list('studios').find(row=>row.id===studioId);
  const checkFor = id => list('skillChecks').find(row=>row.id===id);
  const save = row => checkFor(row.id) ? update('skillChecks',row) : insert('skillChecks',row);

  function validCandidate(skill,candidate) {
    return candidate && sameSkill(skill,candidate) && sha.test(candidate.commit??'') && candidate.commit!==skill.commit &&
      typeof candidate.content==='string' && Boolean(candidate.content.trim()) && candidate.content.length<=256_000 &&
      candidate.url===`https://github.com/${candidate.repo}/blob/${candidate.commit}/${candidate.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  function refresh({studioId,force=false}) {
    if (!checkVersion || isClosed()) return Promise.resolve([]);
    if (running.has(studioId)) return running.get(studioId).promise;
    const studio=studioFor(studioId);
    if (!studio || studio.archivedAt || studio.projectDetached) return Promise.resolve([]);
    const ids=currentIds(studio);
    const due=list('skills').filter(skill=>{
      if(skill.studioId!==studioId || !ids.has(skill.id))return false;
      const saved=checkFor(skill.id);
      const time=clock().getTime();
      return saved?.status!=='approved' && (!saved?.retryAt || Date.parse(saved.retryAt)<=time) &&
        (force || !saved?.nextCheckAt || Date.parse(saved.nextCheckAt)<=time);
    });
    if (!due.length) return Promise.resolve(checksFor(studioId));
    const controller=new AbortController();
    const promise=(async()=>{
      for(const skill of due){
        let result;
        try {result=await checkVersion(skill,{signal:controller.signal});}
        catch(error){
          if(controller.signal.aborted)return [];
          result={status:'unavailable',message:String(error.message).slice(0,500)};
        }
        if(isClosed() || controller.signal.aborted || !studioFor(studioId)) return [];
        const saved=checkFor(skill.id);
        if(saved?.status==='approved' || !currentIds(studioFor(studioId)).has(skill.id))continue;
        const date=clock().getTime();
        const base={id:skill.id,studioId,checkedAt:new Date(date).toISOString(),nextCheckAt:new Date(date+day).toISOString()};
        if(result?.status==='available' && validCandidate(skill,result.candidate)){
          const declined=saved?.declinedCommit===result.candidate.commit;
          save({...base,status:declined?'declined':'available',candidate:result.candidate,declinedCommit:declined?saved.declinedCommit:undefined});
        }else if(result?.status==='current'){
          save({...base,status:'current',observedCommit:result.observedCommit});
        }else{
          const retryAt=Date.parse(result?.retryAt);
          save({...base,status:'unavailable',message:String(result?.message??'Invalid version response').slice(0,500),
            candidate:saved?.candidate,declinedCommit:saved?.declinedCommit,
            retryAt:Number.isFinite(retryAt)&&retryAt>date?new Date(retryAt).toISOString():undefined,
            nextCheckAt:new Date(Math.max(date+retryDelay,Number.isFinite(retryAt)?retryAt:0)).toISOString()});
        }
        changed();
      }
      return isClosed()?[]:checksFor(studioId);
    })().finally(()=>running.delete(studioId));
    running.set(studioId,{controller,promise});
    return promise;
  }

  function applyPending(studioId) {
    const pending=checksFor(studioId).filter(row=>row.status==='approved');
    if(!pending.length)return true;
    if(activeCount(studioId))return false;
    transaction(()=>{
      let studio=read('studios',studioId,'Студия');
      for(const row of pending){
        const skill=read('skills',row.id,'Навык');
        const agents=studio.agents.filter(agent=>agent.rosterStatus!=='retired' && agent.skillIds?.includes(skill.id));
        if(!agents.length || !validCandidate(skill,row.candidate)){
          save({...row,status:'superseded',candidate:undefined});
          continue;
        }
        const existing=list('skills').find(other=>other.studioId===studioId && sameSkill(other,skill) && other.commit===row.candidate.commit);
        const approval={fromSkillId:skill.id,agentIds:agents.map(agent=>agent.id),approvedAt:row.approvedAt};
        const next=existing
          ? update('skills',{...existing,versionApprovals:[...(existing.versionApprovals??[]),approval]})
          : insert('skills',{...row.candidate,id:randomUUID(),studioId,createdAt:row.approvedAt,versionApprovals:[approval]});
        const ids=new Set(approval.agentIds);
        studio={...studio,agents:studio.agents.map(agent=>ids.has(agent.id)
          ? {...agent,skillIds:[...new Set(agent.skillIds.map(id=>id===skill.id?next.id:id))]} : agent)};
        save({...row,status:'applied',candidate:undefined,nextSkillId:next.id});
        if(!checkFor(next.id))save({id:next.id,studioId,status:'current',observedCommit:next.commit,
          checkedAt:row.checkedAt,nextCheckAt:new Date(clock().getTime()+day).toISOString()});
      }
      update('studios',studio);
    });
    changed();
    return true;
  }

  function decide({studioId,skillId,commit,decision}) {
    const studio=read('studios',studioId,'Студия');
    const skill=read('skills',skillId,'Навык');
    const saved=checkFor(skillId);
    if(skill.studioId!==studioId || !currentIds(studio).has(skill.id) || !validCandidate(skill,saved?.candidate) ||
      saved.candidate.commit!==commit || !['apply','decline'].includes(decision))throw new Error('Версия навыка изменилась или больше недоступна.');
    if(decision==='decline'){
      return changed(save({...saved,status:'declined',declinedCommit:commit,approvedAt:undefined}));
    }
    save({...saved,status:'approved',approvedAt:clock().toISOString(),declinedCommit:undefined});
    applyPending(studioId);
    wake(studioId);
    return changed(checkFor(skillId));
  }

  function dispose(){
    for(const {controller} of running.values())controller.abort();
  }
  return {refresh,decide,applyPending,dispose};
}
