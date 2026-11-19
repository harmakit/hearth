'use strict';
const db = window.fixture;
const root = document.querySelector('#app');
const statuses = ['В очереди','В работе','На проверке','Готово','Заблокирована'];
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const get = (items,id) => items.find(i => i.id === id);
const agent = id => get(db.agents,id) || {id,name:'Владелец',role:'Владелец студии'};
const num = n => n.toLocaleString('ru-RU');
const total = (list,key) => list.reduce((v,r) => v + r[key],0);
const stamp = s => new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(s));
const duration = seconds => Math.floor(seconds/60)+' мин '+seconds%60+' с';
const empty = s => '<p class="empty">'+h(s)+'</p>';
const link = (url,label) => `<a href="#${h(url)}">${h(label)}</a>`;
const taskLink = id => link('tasks/'+id,id+' · '+get(db.tasks,id).title);
const byAgent = id => link('agent/'+id,agent(id).name+' · '+agent(id).role);
const badge = s => `<span class="status s${statuses.indexOf(s)}">${h(s)}</span>`;
const section = (name,body) => `<section class="section"><h3>${h(name)}</h3>${body}</section>`;
const options = (list,chosen) => list.map(([v,label])=>`<option value="${h(v)}" ${chosen===v?'selected':''}>${h(label)}</option>`).join('');
const table = (heads,lines) => `<div class="wrap"><table class="compact"><thead><tr>${heads.map(v=>'<th scope="col">'+h(v)+'</th>').join('')}</tr></thead><tbody>${lines.map(line=>'<tr>'+line.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`;
let search='', filter='', currentTask='T-9', scrollList=0;
let draft={goal:'Подготовить руководство по первому рабочему дню',audience:'',stage:'brief',revision:0,notes:'',plan:[],approved:[]};
function rows(){
  const tasks=db.tasks.filter(t=>(!filter||t.status===filter)&&[t.id,t.title,t.description,t.sprint,t.epic,agent(t.owner).name].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return tasks.map(t=>`<button class="row" data-task="${h(t.id)}" ${t.id===currentTask?'aria-current="true"':''}><span class="mono">${h(t.id)}</span><span><strong>${h(t.title)}</strong><span class="sub">${h(agent(t.owner).name)} · ${h(t.epic)} · ${h(t.sprint)} · ${h(t.priority)}</span></span>${badge(t.status)}</button>`).join('')||empty('По этим условиям задач нет.');
}
function register(pane){
  const done=db.tasks.filter(t=>t.status==='Готово').length, blocked=db.tasks.filter(t=>t.status==='Заблокирована').length;
  return `<div class="heading"><div><p class="path">Студия документации / Работа</p><h1>Реестр задач</h1></div><div class="counts"><span>Всего <b>${db.tasks.length}</b></span><span>Готово <b>${done}</b></span><span>Заблокировано <b>${blocked}</b></span></div></div><div class="workspace"><aside class="register" aria-label="Список задач"><div class="filters"><input id="search" type="search" aria-label="Найти задачу" placeholder="Название, ID, агент…" value="${h(search)}"><select id="filter" aria-label="Фильтр по статусу">${options([['','Все статусы'],...statuses.map(s=>[s,s])],filter)}</select></div><div class="rows">${rows()}</div></aside><article tabindex="-1" class="pane" aria-label="Подробности">${pane}</article></div>`;
}
function event(ev){return `<div class="event"><b>${ev.agent==='owner'?'Владелец':byAgent(ev.agent)}</b><time datetime="${h(ev.time)}">${h(stamp(ev.time))}</time><p>${h(ev.text)}</p></div>`;}
function relations(t){
 const deps=t.depends.map(id=>['Зависит от',id]), downstream=db.tasks.filter(x=>x.depends.includes(t.id)).map(x=>['Ожидает эту задачу',x.id]);
 const direct=new Set([...deps,...downstream].map(pair=>pair[1]));
 const peers=[...new Set([...t.related,...db.tasks.filter(x=>x.related.includes(t.id)).map(x=>x.id)])].filter(id=>!direct.has(id));
 const all=[...deps,...downstream,...peers.map(id=>['Связана с',id])];
 return all.map(([label,id])=>`<div class="relation"><span class="tag">${label}</span>${taskLink(id)} ${badge(get(db.tasks,id).status)}</div>`).join('')||empty('У задачи пока нет связей.');
}
function fileRow(id){
 const f=get(db.files,id);
 return `<div class="file"><a href="${h(f.path)}" target="_blank" rel="noopener">${h(f.name)}</a> <span class="sub">· ${h(agent(f.agent).name)}</span><p>${h(f.description)}</p><div class="actions"><span class="mono">${h(f.path)}</span>${link('folder/'+f.id,'Показать в папке')}</div></div>`;
}
function consumption(t){
 if(!t.runs.length)return empty('Данных о запусках и расходе пока нет.');
 const input=total(t.runs,'input'),out=total(t.runs,'output'),cache=total(t.runs,'cached');
 return `<p class="lede"><strong>${num(input+out)} токенов</strong> · ${h(duration(total(t.runs,'seconds')))} суммарно</p><p class="factline">Вход ${num(input)} · из них из кэша ${num(cache)} · выход ${num(out)}</p>`+table(['Начало / агент','Модель / effort','Вход / выход','Из кэша','Время / итог'],t.runs.map(r=>[h(stamp(r.time))+'<br>'+byAgent(r.agent),h(r.model)+'<br>'+h(r.effort),num(r.input)+' / '+num(r.output),num(r.cached),h(duration(r.seconds))+'<br>'+h(r.status)]));
}
function taskPane(t,tab){
 const epic=get(db.epics,t.epic);
 const tabs=[['overview','Обзор'],['discussion','Комментарии · '+t.comments.length],['runs','Запуски · '+t.runs.length],['log','Журнал · '+t.events.length]];
 const head=`<div class="trail">${link('epic/'+t.epic,t.epic+' · '+epic.title)} <span>›</span> ${link('sprint/'+encodeURIComponent(t.sprint),t.sprint)}</div><h2 class="title">${h(t.title)}</h2><div class="meta"><span class="mono">${h(t.id)}</span>${badge(t.status)}<span>${h(t.priority)} · ${t.points} б.</span>${byAgent(t.owner)}</div>`;
 const nav='<div class="tabs" aria-label="Разделы задачи">'+tabs.map(([key,label])=>`<a ${key===tab?'aria-current="page"':''} href="#tasks/${h(t.id)}/${key}">${h(label)}</a>`).join('')+'</div>';
 const sorted = arr => [...arr].sort((a,b)=>b.time.localeCompare(a.time));
 if(tab==='discussion')return head+nav+section('Обсуждение',sorted(t.comments).map(event).join('')||empty('Комментариев пока нет.'))+`<form id="comment"><label class="field"><span>Ваш комментарий</span><textarea required maxlength="3000" name="body" rows="2"></textarea></label><button class="ctrl">Добавить комментарий</button></form>`;
 if(tab==='runs')return head+nav+section('Расход по запускам',consumption(t));
 if(tab==='log')return head+nav+section('История действий',sorted(t.events).map(event).join('')||empty('Событий пока нет.'));
 const people=[...new Set([t.owner,...t.events.map(e=>e.agent),...t.comments.map(c=>c.agent),...t.runs.map(r=>r.agent)])];
 const last=sorted([...t.events,...t.comments])[0],tokenCount=total(t.runs,'input')+total(t.runs,'output');
 return head+nav+section('Описание',t.description.split('\n\n').map(p=>'<p>'+h(p)+'</p>').join(''))+
 section('Критерии приёмки','<ul class="ticks">'+t.criteria.map(c=>'<li>'+h(c)+'</li>').join('')+'</ul>')+
 section('Связанные задачи',relations(t))+
 section('Артефакты · '+t.files.length,t.files.map(fileRow).join('')||empty('Файлов пока нет.'))+
 section('Кто участвовал','<div class="links">'+people.map(id=>id==='owner'?'Владелец':byAgent(id)).join(' ')+'</div>')+
 section('Встречи и решения',t.meetings.map(id=>'<div class="relation">'+link('meeting/'+id,id+' · '+get(db.meetings,id).title)+'</div>').join('')||empty('Связанных встреч пока нет.'))+
 section('Последнее действие',last?event(last):empty('Действий пока нет.'))+
 `<div class="factline">${link('tasks/'+t.id+'/runs',t.runs.length?'Расход · '+num(tokenCount)+' токенов':'Запуски')} · ${link('tasks/'+t.id+'/log','Открыть журнал')}</div><details><summary>Сменить исполнителя</summary><label class="field"><span>Ответственный агент</span><select id="assign">${options(db.agents.map(a=>[a.id,a.name+' · '+a.role]),t.owner)}</select></label></details>`;
}
function taskTable(ts){return table(['Задача','Ответственный','Состояние','Баллы'],ts.map(t=>[taskLink(t.id),h(agent(t.owner).name),badge(t.status),t.points]));}
function objectPane(kind,id){
 const back='<div class="trail">'+link('tasks/'+currentTask,'← К задаче '+currentTask)+'</div>';
 if(kind==='folder'){
 const f=get(db.files,id); if(!f)return back;
 return back+'<h2 class="title">Папка артефактов</h2><p class="factline">Предпросмотр папки · files/</p>'+db.files.map(x=>`<div class="file ${x===f?'highlight':''}"><a target="_blank" rel="noopener" href="${h(x.path)}">${h(x.path.split('/').pop())}</a> ${x===f?'· выбранный файл':''}<p>${h(x.description)}</p></div>`).join('');
 }
 if(kind==='meeting'){
 const m=get(db.meetings,id);if(!m)return back;
 return back+`<p class="path">Протокол · ${h(m.id)} · ${h(m.sprint)}</p><h2 class="title">${h(m.title)}</h2>`+section('Повестка',h(m.agenda))+section('Решение',h(m.decision))+section('Позиции участников',m.positions.map(p=>`<div class="event"><b>${byAgent(p.agent)}</b><p>${h(p.text)}</p></div>`).join(''))+section('Затронутые задачи',taskTable(m.tasks.map(id=>get(db.tasks,id))));
 }
 if(kind==='agent'){
 const a=get(db.agents,id);if(!a)return back;
 const touched=db.tasks.filter(t=>[t.owner,...t.events.map(e=>e.agent),...t.comments.map(c=>c.agent),...t.runs.map(r=>r.agent)].includes(a.id));
 return back+`<p class="path">Команда студии</p><h2 class="title">${h(a.name)} · ${h(a.role)}</h2><div class="meta">${h(a.model)} · ${h(a.effort)}</div>`+section('Задачи с участием агента',taskTable(touched));
 }
 const e=kind==='epic'?get(db.epics,id):null;
 const ts=db.tasks.filter(t=>kind==='epic'?t.epic===id:t.sprint===id);
 const done=ts.filter(t=>t.status==='Готово');
 const groups=[...new Set(ts.map(t=>t.sprint))].sort();
 return back+`<p class="path">${e?h(e.id)+' · Фаза «'+h(e.phase)+'»':'Спринт студии'}</p><h2 class="title">${h(e?.title||id)}</h2>`+(e?section('Цель',h(e.goal)+'<p class="factline">Ведёт '+byAgent(e.owner)+'</p>'):'')+
 section('Прогресс',`<b>${done.length} из ${ts.length}</b> задач · ${total(done,'points')} из ${total(ts,'points')} баллов`)+
 (e?section('По спринтам',table(['Спринт','Готово / всего','Принято баллов'],groups.map(s=>{const list=ts.filter(t=>t.sprint===s),d=list.filter(t=>t.status==='Готово');return [link('sprint/'+encodeURIComponent(s),s),d.length+' / '+list.length,total(d,'points')+' / '+total(list,'points')];}))):'')+
 section('Задачи',taskTable(ts));
}
function wizard(){
 const intro='<div class="wizard"><p class="path">Hearth / Создание студии</p>';
 if(draft.stage==='approved')return intro+'<h1>Первый спринт утверждён</h1><div class="plan"><p>В реестре появились три задачи. Проверка результата ждёт выполнения первых двух.</p>'+taskTable(draft.approved.map(id=>get(db.tasks,id)))+'</div></div>';
 if(draft.stage==='brief')return intro+`<h1>С чего начнёт студия?</h1><form id="brief"><label class="field"><span>Какой результат должна подготовить студия?</span><textarea required name="goal" rows="2" maxlength="800">${h(draft.goal)}</textarea></label><label class="field"><span>Кто будет пользоваться результатом? <small>Необязательно</small></span><input name="audience" value="${h(draft.audience)}" placeholder="Например, разработчики в свой первый рабочий день" maxlength="240"><small>Директор учтёт опыт этих людей, когда предложит, как проверить результат.</small></label>${section('Что вы получите','Директор предложит план первого спринта. В нём будут результат, задачи, исполнители, модели и критерии приёмки. Вы сможете изменить предложение до старта работ.')}<div class="actions"><button class="ctrl primary">Подготовить план первого спринта</button></div></form></div>`;
 return intro+`<h1>План первого спринта</h1><div class="plan"><div class="meta">${badge('На проверке')} Версия ${draft.revision}</div><h2>${h(draft.goal)}</h2><p class="factline">${draft.audience?'Кто воспользуется результатом · '+h(draft.audience):'Аудитория не указана'}</p>${section('Что будет готово','Черновик результата, перечень обязательных требований и отчёт независимой проверки.')}<form id="approve"><h3>Работы и исполнители</h3>${draft.plan.map((p,i)=>`<div class="section"><label class="field"><span>Задача ${i+1}</span><input required maxlength="240" name="title${i}" value="${h(p.title)}"></label><div class="actions"><label>Исполнитель <select name="agent${i}">${options(db.agents.map(a=>[a.id,a.name+' · '+a.role]),p.owner)}</select></label><label>Модель <select name="model${i}">${options(['gpt-6.1-sol','gpt-6.1-terra'].map(v=>[v,v]),p.model)}</select></label><label>Effort <select name="effort${i}">${options(['low','medium','high','xhigh'].map(v=>[v,v]),p.effort)}</select></label></div><p class="factline">${h(p.criterion)}</p></div>`).join('')}<p class="factline">Первые две задачи могут идти параллельно. Третья откроется, когда обе будут готовы.</p><div class="actions"><button class="ctrl primary">Утвердить план и начать спринт</button><button class="ctrl" type="button" id="revise">Изменить задание директору</button></div></form></div></div>`;
}
function newPlan(){
 const who=draft.audience||'пользователь результата';
 draft.plan=[
 {title:'Подготовить черновик',owner:'writer',effort:'medium',criterion:'Черновик покрывает цель «'+draft.goal+'».'},
 {title:'Составить критерии приёмки',owner:'reviewer',effort:'high',criterion:'Для каждого требования описан наблюдаемый результат.'},
 {title:'Проверить результат по критериям',owner:'qa',effort:'medium',criterion:'Проверяющий проходит сценарий в роли «'+who+'» и прикладывает отчёт.'}
 ].map(p=>({...p,model:'gpt-6.1-sol'}));
 draft.revision++;draft.stage='review';
}
function approve(form){
 const ids=[1,2,3].map((_,i)=>'T-'+(Math.max(...db.tasks.map(t=>Number(t.id.slice(2))))+1+i));
 const epic='E-4',sprint='Первый спринт новой студии';
 db.epics.push({id:epic,title:draft.goal,goal:draft.goal,owner:'director',phase:'Первый результат'});
 draft.plan.forEach((p,i)=>{
 const owner=form.get('agent'+i),model=form.get('model'+i),effort=form.get('effort'+i),time=new Date().toISOString();
 db.tasks.unshift({id:ids[i],title:form.get('title'+i).trim(),epic,sprint,owner,status:i===2?'Заблокирована':'В очереди',priority:'P1',points:[3,2,2][i],description:draft.goal+(draft.audience?'\n\nРезультатом будут пользоваться '+draft.audience+'.':''),criteria:[p.criterion],depends:i===2?ids.slice(0,2):[],related:[],files:[],meetings:[],comments:[],runs:[],events:[{time,agent:'owner',text:'Утверждён первый план. Назначение · '+agent(owner).name+' · '+model+' · '+effort+'.'}]});
 });
 draft.approved=ids;draft.stage='approved';
}
function render(){
 const [kind='tasks',raw='',section='overview']=location.hash.slice(1).split('/');
 const id=decodeURIComponent(raw);
 const launching=kind==='launch';
 for(const [node,active] of [['navTasks',!launching],['navLaunch',launching]]){
 const el=document.getElementById(node); if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
 }
 if(launching){root.innerHTML=wizard();return;}
 const object=['epic','sprint','meeting','agent','folder'].includes(kind);
 const t=get(db.tasks,id)||get(db.tasks,currentTask);
 if(!object)currentTask=t.id;
 const before=root.querySelector('.rows');if(before)scrollList=before.scrollTop;
 root.innerHTML=register(object?objectPane(kind,id):taskPane(t,section));
 root.querySelector('.rows').scrollTop=scrollList;
 document.querySelector('#search').oninput=e=>{search=e.target.value;root.querySelector('.rows').innerHTML=rows();};
 document.querySelector('#filter').onchange=e=>{filter=e.target.value;root.querySelector('.rows').innerHTML=rows();};
 const assign=document.querySelector('#assign');
 if(assign)assign.onchange=e=>{const old=agent(t.owner);t.owner=e.target.value;t.events.push({time:new Date().toISOString(),agent:'owner',text:'Передал задачу от '+old.name+' агенту '+agent(t.owner).name+'.'});render();};
}
root.addEventListener('click',e=>{
 const row=e.target.closest('[data-task]');if(row){location.hash='tasks/'+row.dataset.task;}
 if(e.target.id==='revise'){draft.stage='brief';render();}
});
root.addEventListener('submit',e=>{
 e.preventDefault();const form=new FormData(e.target);
 if(e.target.id==='brief'){if(!form.get('goal').trim())return;draft.goal=form.get('goal').trim();draft.audience=form.get('audience').trim();newPlan();}
 if(e.target.id==='approve'){approve(form);}
 if(e.target.id==='comment'){const text=form.get('body').trim();if(!text)return;const t=get(db.tasks,currentTask),time=new Date().toISOString();t.comments.push({time,agent:'owner',text});t.events.push({time,agent:'owner',text:'Добавил комментарий к задаче.'});document.getElementById('announce').textContent='Комментарий добавлен';}
 render();
});
window.addEventListener('hashchange',()=>{render();const pane=root.querySelector('.pane');if(pane&&location.hash!=='#tasks')pane.focus({preventScroll:true});});
render();
