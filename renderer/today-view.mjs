import {copy, inboxLabelIn} from './copy.mjs';
import {escapeMarkup as safe,stageMark} from './presentation.mjs';

const scopedKey = (studioId,id)=>JSON.stringify([studioId,id]);
const unresolved = task => !['done','replaced'].includes(task.stage) && task.status!=='cancelled';
const appSettingsActions = new Set(['authenticate','configuration']);
const decisionType = {
  plan:'Согласование плана',acceptance:'Приёмка результата',question:'Вопрос',error:'Требуется внимание',
  reconcile:'Прерванный шаг',meeting:'Решение встречи',roster:'Изменение состава',phase:'Завершение фазы',priority:'Предложение по приоритету',
};
const actionText = {
  plan:'Посмотреть план', acceptance:'Открыть приёмку', question:'Ответить',retry:'Повторить запуск',
  resume:'Возобновить',settings:'Настройки приложения',project:'Настройки студии',reconcile:'Посмотреть прерванный шаг',
  meeting:'Открыть встречу',roster:'Изменение состава',phase:'Решение о завершении',priority:'Применить приоритет',
};

export function todayItems(snapshot, projectAvailability = {}) {
  const {studios=[],inbox=[],tasks=[],attempts=[],plans=[],meetings=[],rosterProposals=[],phases=[],conversationMessages=[]}=snapshot;
  const active = new Map(studios.filter(s=>!s.archivedAt).map(s=>[s.id,s]));
  const index = rows=>new Map(rows.map(r=>[scopedKey(r.studioId,r.id),r]));
  const [taskByKey,attemptByKey,planByKey,meetingByKey,rosterByKey] = [tasks,attempts,plans,meetings,rosterProposals].map(index);
  const consumers = new Map();
  for(const task of tasks.filter(unresolved)) for(const id of task.dependencies??[]){
    const key=scopedKey(task.studioId,id);
    if(!taskByKey.has(key))continue;
    if(!consumers.has(key))consumers.set(key,[]);
    consumers.get(key).push(task.id);
  }
  function affected(studioId,roots) {
    const seen=new Set(roots), ids=[];
    for(let i=0;i<roots.length;i++)for(const consumer of consumers.get(scopedKey(studioId,roots[i]))??[]){
      if(seen.has(consumer))continue;
      ids.push(consumer);seen.add(consumer);roots.push(consumer);
    }
    return ids;
  }
  const output=[], covered=new Set();
  function append(row){
    const key=scopedKey(row.studioId,row.target.kind+':'+row.target.id);
    if(covered.has(key))return;
    covered.add(key);output.push(row);
  }
  for(const entry of inbox){
    const {studioId,kind,id}=entry, studio=active.get(studioId);
    if(!studio||entry.status!=='open')continue;
    const task=taskByKey.get(scopedKey(studioId,entry.taskId));
    let target={studioId,kind:'inbox',id}, action=kind;
    if(kind==='plan'&&planByKey.get(scopedKey(studioId,entry.planId))?.status!=='pending')continue;
    if(kind==='meeting'){
      const meeting=meetingByKey.get(scopedKey(studioId,entry.meetingId));
      if(meeting?.stage!=='owner_review'||meeting.activeStep)continue;
      target={studioId,kind,id:meeting.id};
    }
    if(kind==='roster'){
      const roster=rosterByKey.get(scopedKey(studioId,entry.proposalId));
      if(roster?.status!=='pending')continue;
      target={studioId,kind,id:roster.id};
    }
    if(kind==='reconcile'){
      const attempt=attemptByKey.get(scopedKey(studioId,entry.attemptId));
      if(attempt?.status!=='reconcile'||attempt.processActive)continue;
    }
    if(kind==='error'){
      const attempt=attempts.findLast(a=>a.studioId===studioId&&a.taskId===entry.taskId&&a.status==='failed');
      if(appSettingsActions.has(attempt?.action))action='settings';
      else if(studio.projectDetached||projectAvailability[studioId]?.available===false)action='project';
      else if(task?.status==='failed'&&(!task.workflowManaged||studio.wipLimit>1||task.training?.bootstrap))action=studio.manualPaused||studio.lifecycle==='paused'?'resume':'retry';
      else if(studio.lifecycle==='error'&&!studio.archivedAt)action='resume';
      else continue;
    }
    if(!Object.hasOwn(decisionType,kind))continue;
    const members=(entry.review?.members??[]).map(m=>m.taskId).filter(taskId=>taskByKey.has(scopedKey(studioId,taskId)));
    const roots=[...new Set([...(task&&unresolved(task)?[task.id]:[]),...members])];
    const dependencies=affected(studioId,[...roots]);
    const affectedTaskIds=[...new Set([...members,...dependencies])];
    append({studioId,kind,id,inboxId:id,label:entry.title,detail:entry.body,createdAt:entry.createdAt,affectedTaskIds,target,action,blocking:dependencies.length>0});
  }
  for(const phase of phases) if(active.has(phase.studioId)&&phase.transition?.status==='pending')
    append({studioId:phase.studioId,kind:'phase',id:phase.transition.id,label:phase.title,detail:phase.goal,createdAt:phase.transition.proposedAt,affectedTaskIds:[],
      target:{studioId:phase.studioId,kind:'phase',id:phase.id},action:'phase',blocking:false});
  for(const meeting of meetings) if(active.has(meeting.studioId)&&meeting.stage==='owner_review'&&!meeting.activeStep)
    append({studioId:meeting.studioId,kind:'meeting',id:meeting.id,label:meeting.title,detail:meeting.ownerReason,createdAt:meeting.updatedAt,affectedTaskIds:[],
      target:{studioId:meeting.studioId,kind:'meeting',id:meeting.id},action:'meeting',blocking:false});
  for(const proposal of rosterProposals) if(active.has(proposal.studioId)&&proposal.status==='pending')
    append({studioId:proposal.studioId,kind:'roster',id:proposal.id,label:proposal.roleTitle??proposal.agent?.roleTitle??proposal.reason,detail:proposal.reason,createdAt:proposal.createdAt,affectedTaskIds:[],
      target:{studioId:proposal.studioId,kind:'roster',id:proposal.id},action:'roster',blocking:false});
  for(const message of conversationMessages){
    const proposal=message.priorityProposal, studio=active.get(message.studioId);
    if(!proposal||proposal.appliedAt||!studio||(studio.backlogVersion??0)!==proposal.baseVersion||
        !taskByKey.has(scopedKey(message.studioId,proposal.taskId)))continue;
    append({studioId:message.studioId,kind:'priority',id:message.id,label:proposal.taskTitle,detail:message.text,createdAt:message.createdAt,affectedTaskIds:[],
      target:{studioId:message.studioId,kind:'priority',id:message.id},action:'priority',blocking:false});
  }
  return output.sort((a,b)=>Number(b.blocking)-Number(a.blocking)||
    String(a.createdAt??'9999').localeCompare(String(b.createdAt??'9999'))||
    String(a.id).localeCompare(String(b.id))||String(a.studioId).localeCompare(String(b.studioId)));
}

export function initialWorkspaceView(snapshot, availability) {
  return todayItems(snapshot,availability).length?'today':'workspace';
}

export function renderToday(snapshot, {projectAvailability,studioFilter='',outcome,hasDraft=false} = {}) {
  const studios = (snapshot.studios??[]).filter(s=>!s.archivedAt);
  const rows = todayItems(snapshot,projectAvailability).filter(r=>!studioFilter||r.studioId===studioFilter);
  const locale=snapshot.appLocale??'en';
  const select = studios.length>1 ? copy`<label class="today-filter"><span>Студия</span><select data-today-filter><option value="">Все студии</option>${studios.map(s=>`<option value="${safe(s.id)}"${s.id===studioFilter?' selected':''}>${safe(s.name)}</option>`).join('')}</select></label>` : '';
  const nameFor = id=>studios.find(s=>s.id===id)?.name??'';
  const record = row => {
    const stamp=Date.parse(row.createdAt);
    const time=Number.isFinite(stamp)?new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(stamp):'';
    const label=row.inboxId?inboxLabelIn({kind:row.kind,title:row.label},locale):row.label;
    const data=`data-today-id="${safe(row.id)}" data-today-studio="${safe(row.studioId)}" data-today-kind="${safe(row.kind)}"`;
    const stats=row.affectedTaskIds.length?copy`Связанных задач: ${row.affectedTaskIds.length}`:'';
    const reason=String(row.detail??'').replace(/\s+/g,' ').trim();
    const snippet=reason.length>128?reason.slice(0,125)+'…':reason;
    const action=copy(actionText[row.action]??'Открыть');
    return `<li class="today-row"><button type="button" class="today-open" ${data}><strong>${safe(label||copy(decisionType[row.kind]))}</strong><small>${safe(nameFor(row.studioId))}${snippet?' · '+safe(snippet):''}</small></button>
      <div class="today-meta">${stageMark(row.blocking?'blocked':'qa',copy(decisionType[row.kind]))}${stats?`<small>${stats}</small>`:''}${time?`<time class="muted">${safe(time)}</time>`:''}<span class="today-action">${safe(action)}</span></div></li>`;
  };
  return copy`<header class="page-heading"><h1>Сегодня</h1><div class="actions"><button type="button" class="action" data-open="studio">${copy(hasDraft?'Продолжить создание':'Новая студия')}</button></div></header>
    ${outcome?`<section class="today-outcome" aria-live="polite"><strong>${safe(outcome.label)}</strong><p>${safe(outcome.detail)}</p><div class="actions">
      ${outcome.taskId?`<button type="button" class="action secondary" data-portfolio-task="${safe(outcome.taskId)}" data-studio="${safe(outcome.studioId)}">${copy('Открыть задачу')}</button>`:''}
      <button type="button" class="action secondary" data-today-next>${rows.length?copy('Следующее решение'):copy('Все студии')}</button></div></section>`:''}
    <div class="row today-heading"><h2>Нужно решение · ${rows.length}</h2>${select}</div>
    ${rows.length?`<ul class="today-list">${rows.map(record).join('')}</ul>`:copy('<p class="muted">Открытых решений нет.</p>')}`;
}
