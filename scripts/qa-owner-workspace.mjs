import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioInterfaceFixture } from '../test/fixtures/studio-interface.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = await (async()=>{await mkdir(join(root,'.tmp'),{recursive:true});return mkdtemp(join(root,'.tmp','owner-qa-'));})();
console.log('QA profile:', run);
const [profile, work, editorial, home, bin] = ['profile','git-work','editorial','home','bin'].map(p => join(run, p));
await Promise.all([profile, work, editorial, home, bin].map(p => mkdir(p)));
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: work, encoding:'utf8', env: { PATH:'/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' } }).trim();
await writeFile(join(work, 'README.md'), '# QA base\n');
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
git('add', 'README.md'); git('commit', '-qm', 'Baseline'); git('branch', 'qa-delivery');
const baseline = git('rev-parse', 'HEAD');
const fixture = new URL('../test/fixtures/owner-runtime.mjs', import.meta.url);
for (const provider of ['codex','claude']) {
  const binary = join(bin, provider);
  await writeFile(binary, '#!/bin/sh\nexec '+JSON.stringify(process.execPath)+' ' + "'" + fileURLToPath(fixture) + "' '" + provider + "' \"$@\"\n");
  await chmod(binary, 0o700);
}
const bundle = process.env.HEARTH_BUNDLE;
const require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(); if (result) return result;
    await delay(125);
  }
  throw new Error(label);
}

async function launch() {
  const zoomCheck=process.env.HEARTH_QA_ZOOM==='1';
  const child = spawn(bundle || require('electron'), [...(bundle ? [] : [root]), ...(zoomCheck ? ['--inspect=127.0.0.1:0'] : []), '--remote-debugging-port=0', '--user-data-dir=' + profile], {
    cwd: root, env: { HOME:home, PATH:bin + ':/opt/homebrew/bin:/usr/bin:/bin', LANG:'en_US.UTF-8', HEARTH_DATA_DIR:profile, CODEX_HOME:join(home,'.codex'), CLAUDE_CONFIG_DIR:join(home,'.claude'), TMPDIR:run, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  let mainInspector;
  child.stderr.on('data', chunk => {
    diagnostic = (diagnostic + chunk).slice(-6000);
    mainInspector ??= diagnostic.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/)?.[1];
  });
  let ws;
  const close = async () => {
    ws?.close();
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 9000);
    await exited; clearTimeout(timer);
  };
  try {
    const endpoint = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode) throw new Error('Electron exited: ' + diagnostic);
      for (const base of [profile, join(profile,'chromium')]) {
        const port = parseInt(await readFile(join(base, 'DevToolsActivePort'), 'utf8').catch(() => ''), 10);
        if (!port) continue;
        const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).catch(() => []);
        const page = pages.find(entry => entry.url === 'hearth://app/index.html');
        if (page) return page.webSocketDebuggerUrl;
      }
    }, 'Electron did not open: ' + diagnostic);
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once:true }); ws.addEventListener('error', reject, { once:true }); });
    const pending = new Map(); const errors = []; let sequence = 0;
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const req = pending.get(message.id); pending.delete(message.id);
        if (message.error) req.reject(new Error(message.error.message)); else req.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description);
    });
    const rpc = (method, params = {}) => new Promise((resolve,reject) => {
      pending.set(++sequence, { resolve, reject }); ws.send(JSON.stringify({ id:sequence, method, params }));
    });
    await rpc('Runtime.enable'); await rpc('Page.enable');
    const evaluate = async (f, ...args) => {
      const {result,exceptionDetails} = await rpc('Runtime.evaluate', { expression:`(${f})(...${JSON.stringify(args)})`, returnByValue:true, awaitPromise:true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    await eventually(() => evaluate(() => Boolean(window.hearth && document.querySelector('main .page-heading') && document.querySelector('[data-view="app-settings"]'))), 'Renderer did not load');
    const click = async selector => {
      await eventually(() => evaluate(s => { const e = document.querySelector(s); return e && !e.disabled && e.getClientRects().length; }, selector), 'Missing button ' + selector);
      await evaluate(s => document.querySelector(s).click(), selector);
    };
    const set = (selector,value) => evaluate((s,v) => { const e = document.querySelector(s); if (!e) throw Error(s); if (typeof v === 'boolean') e.checked = v; else e.value = v; for (const type of ['input','change']) e.dispatchEvent(new Event(type,{bubbles:true})); }, selector,value);
    const request = (command,payload={}) => evaluate((c,p) => window.hearth.request(c,p),command,payload);
    const screenshot = async name => {
      const {data} = await rpc('Page.captureScreenshot',{ format:'png' }); await writeFile(join(run, name+'.png'), Buffer.from(data,'base64'));
    };
    async function setZoom(factor) {
      assert.ok([1,2].includes(factor));
      assert.ok(mainInspector,'No main inspector in the isolated QA process');
      const control=new WebSocket(mainInspector);
      try {
        await new Promise((res,rej)=>{control.onopen=res;control.onerror=rej;});
        const reply=new Promise((res,rej)=>{control.onmessage=e=>{
          const message=JSON.parse(e.data);
          if(message.id===1)message.error || message.result?.exceptionDetails ? rej(new Error(JSON.stringify(message))) : res(message.result.result.value);
        };});
        control.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:
          `(()=>{const w=process.getBuiltinModule('module').createRequire(process.cwd()+'/qa.cjs')('electron').BrowserWindow.getAllWindows()[0].webContents; w.setZoomFactor(${factor});return w.getZoomFactor();})()`,returnByValue:true}}));
        assert.equal(await reply,factor);
      } finally {control.close();}
    }
    return { child, evaluate, set, request, click, errors, screenshot, close, rpc, setZoom };
  } catch (error) { await close(); throw error; }
}


let desktop=await launch();
const {rm,realpath}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const parent=await realpath(await mkdtemp(join(tmpdir(),'hearth-qa-new-')));
const snap=()=>desktop.request('snapshot');
const shot=name=>desktop.screenshot(name);
const choose=async(sel,value)=>{await desktop.set(sel,value);};
const until=async (fn,label,ms=60000)=>eventually(async()=>fn(await snap()),label,ms);
async function quitDesktop(instance){
  const exit=new Promise(resolve=>instance.child.once('exit',resolve));
  const pid=Number(instance.child.pid);
  assert.ok(Number.isSafeInteger(pid)&&pid>0);
  execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',
    "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier("+pid+").terminate"]);
  assert.equal(await Promise.race([exit.then(()=>true),delay(15000).then(()=>false)]),true,'Native Quit');
  await instance.close();
}
async function dragHorizontal(handle, pane, distance) {
  const geometry=await desktop.evaluate((h,p)=>{
    const divider=document.querySelector(h).getBoundingClientRect();
    return {x:divider.x+divider.width/2,y:divider.y+divider.height/2,width:document.querySelector(p).getBoundingClientRect().width};
  }, handle,pane);
  const {x,y,width}=geometry;
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none',buttons:0});
  await delay(100);
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await delay(100);
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+distance/2,y,button:'left',buttons:1});
  await delay(125);
  const middle=await desktop.evaluate(p=>document.querySelector(p).getBoundingClientRect().width,pane);
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+distance,y,button:'left',buttons:1});
  await delay(125);
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+distance,y,button:'left',clickCount:1});
  const final=await desktop.evaluate(p=>document.querySelector(p).getBoundingClientRect().width,pane);
  assert.ok(width < middle && middle < final,`${handle} moved through intermediate widths ${width}, ${middle}, ${final}`);
  return final;
}
const appLocale=async locale=>{
  await desktop.click('[data-view="app-settings"]');
  await choose('[data-settings-locale]',locale);
  await eventually(()=>desktop.evaluate(l=>document.documentElement.lang===l,locale),'Interface language '+locale);
};
try {
  if(process.env.HEARTH_QA_LOCALE){
    await appLocale(process.env.HEARTH_QA_LOCALE);
    await desktop.click('[data-view="workspace"]');
  }
  if(process.env.HEARTH_QA_ONBOARDING_FIX==='1'){
    await appLocale('ru');
    assert.equal(await desktop.evaluate(()=>document.querySelectorAll('[data-settings-locale], #app-locale').length),1);
    await desktop.click('[data-view="workspace"]');
    const plain=join(parent,'guys inc');
    await mkdir(plain);
    await desktop.click('main [data-open=studio]');
    assert.ok(await desktop.evaluate(()=>document.querySelector('[name=firstResult]').tagName==='TEXTAREA'));
    await choose('[name=name]','Onboarding QA');
    await choose('[name=brief]','Книжная студия QA-STOP-PLAN');
    await choose('[name=firstResult]','Придумать пять персонажей');
    if(process.env.HEARTH_QA_TODAY==='1'){
      await desktop.click('[data-save-studio-draft]');
      await quitDesktop(desktop);
      desktop=await launch();
      await desktop.click('main [data-open=studio]');
      assert.equal(await desktop.evaluate(()=>document.querySelector('[name=firstResult]').value),'Придумать пять персонажей');
      console.log('PASS создание → сохранённый черновик → нативный перезапуск → продолжение');
    }
    await desktop.click('[data-wizard-next]');
    await choose('[name=folderMode]','existing');
    await choose('[name=root]',plain);
    await desktop.click('[data-wizard-next]');
    await desktop.click('#dialog-actions button[type=submit]');
    const created=await until(s=>s.studios.find(row=>row.name==='Onboarding QA'),'Create a studio without Git');
    assert.equal(created.projectGit,undefined);
    assert.match(created.brief,/Первая задача — Придумать пять персонажей/);
    await eventually(()=>desktop.evaluate(()=>!document.querySelector('#dialog').open),'Optional Git does not interrupt creation');
    await desktop.click('[data-view="settings"]');
    await desktop.click('[data-open="project-git"]');
    assert.equal(await desktop.evaluate(()=>Boolean(document.querySelector('[name=profileId]'))),false);
    await choose('[name=enabled]',true);
    await desktop.click('#dialog-actions button[type=submit]');
    await eventually(()=>desktop.evaluate(()=>document.querySelector('#dialog-error').textContent.includes('нет Git-репозитория')),'Explain that the selected folder has no repository');
    await desktop.click('#dialog-actions [data-close]');
    assert.equal(await desktop.evaluate(()=>document.querySelector('#navigation [data-view=skills]')?.textContent ?? null),null);
    await desktop.click('#advanced summary');
    assert.ok(await desktop.evaluate(()=>document.querySelector('#advanced [data-open=skill-settings]').getClientRects().length));
    await desktop.click('#advanced [data-view=skills]');
    await desktop.click('[data-view="overview"]');
    await desktop.click('[data-initialize]');
    await desktop.click('[data-run-action="stop"]');
    const hold=await until(s=>s.inbox.find(i=>i.studioId===created.id && i.kind==='reconcile'),'Planning hold');
    await desktop.click('[data-inbox="'+hold.id+'"]');
    await eventually(()=>desktop.evaluate(()=>document.querySelector('#dialog-title').textContent==='Подготовка плана прервана'),'Interrupted plan is identified');
    await desktop.click('#dialog-actions button[type=submit]');
    await until(s=>s.inbox.find(i=>i.id===hold.id && i.status==='resolved'),'Retry placed in queue');
    await desktop.click('[data-run-action="resume"]');
    await until(s=>s.plans.find(p=>p.studioId===created.id && p.status==='pending'),'Retried plan ready for approval');
    await desktop.request('deleteStudio',{studioId:created.id,confirmation:created.name});
    await desktop.click('[data-view="workspace"]');
    console.log('PASS existing non-Git folder, settings, interrupted first plan and resume');
  }
  await desktop.click('main [data-open=studio]');
  await choose('[name=name]','Edition');await choose('[name=brief]','Prepare a book for release.');
  await desktop.click('[data-wizard-next]');await choose('[name=root]',parent);await choose('[name=newFolderName]','Edition');
  await desktop.click('[data-wizard-next]'); await desktop.click('#dialog-actions button[type=submit]');
  const s=await until(x=>x.studios.find(s=>s.name==='Edition'),'Create new project');
  assert.ok(s.projectGit.enabled);
  await desktop.click('[data-initialize]');
  const plan=await until(x=>x.plans.find(p=>p.studioId===s.id&&p.status==='pending'),'Director plan');
  await desktop.click('[data-plan="'+plan.id+'"]');
  await desktop.click('[data-edit-plan-tasks]');
  await choose('[name=sprintReview]','hold');
  await choose('[name=accept0]',false);
  await desktop.click('#dialog-actions button[type=submit]');
  await desktop.click('[data-approve-plan]');
  const stateAtDecision=await until(x=>x.inbox.some(i=>i.review?.members?.length && i.status==='open')?x:null,'Held sprint acceptance',180000);
  const item=stateAtDecision.inbox.find(i=>i.review?.members?.length && i.status==='open');
  const base=execFileSync('git',['-C',s.root,'rev-parse','main'],{encoding:'utf8'}).trim();
  const target=s.projectGit.targetRef;
  const ref=()=>execFileSync('git',['-C',s.root,'rev-parse',target],{encoding:'utf8'}).trim();
  assert.equal(ref(),base);
  if(process.env.HEARTH_QA_TODAY==='1'){
    await desktop.click('[data-view=today]');await desktop.click('[data-today-id="'+item.id+'"]');
  } else {
    await desktop.click('[data-view=inbox]');await desktop.click('[data-inbox="'+item.id+'"]');
  }
  if(process.env.HEARTH_QA_RESIZE==='1') await dragHorizontal('[data-dialog-width]','#dialog',50);
  await shot('01-package-acceptance');
  await desktop.click('#dialog-actions button[type=submit]');
  await until(x=>x.sprints.some(sp=>sp.studioId===s.id&&sp.status==='completed'),'Sprint completion');
  if(process.env.HEARTH_QA_TODAY==='1'){
    await eventually(()=>desktop.evaluate(()=>Boolean(document.querySelector('.today-outcome')?.textContent.includes(
      document.documentElement.lang==='ru'?'Изменения слиты':'Changes merged'))),'Today shows confirmed merge');
    await shot('today-real-merge');
    console.log('PASS Сегодня → решение → подтверждённое слияние');
    await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+s.id+'"]');
  }
  if(await desktop.evaluate(()=>!document.querySelector('#owner-inspector').hidden))await desktop.click('[data-owner-close]');
  await desktop.click('[data-view=inbox]');await desktop.click('[data-scope=resolved]');
  await desktop.click('[data-inbox="'+item.id+'"]');
  assert.ok(await desktop.evaluate(hash=>document.querySelector('#dialog-body').textContent.includes(hash),item.review.key.slice(0,12)));
  assert.equal(await desktop.evaluate(()=>Boolean(document.querySelector('#dialog-actions button[type=submit]'))),false);
  await desktop.click('#dialog-actions [data-close]');
  assert.notEqual(ref(),base);
  assert.ok(execFileSync('git',['-C',s.root,'show',target+':delivery.md'],{encoding:'utf8'}).includes('QA deliverable'));
  console.log('PASS held sprint: worktree > review > owner approval > Git delivery');
  const book=await desktop.request('createStudio',{root:editorial,name:'Редакция',brief:'Рассказ'});
  const question=await desktop.request('createTask',{studioId:book.id,title:'QA Question',prompt:'QA-CODEX-QUESTION'});
  await desktop.request('startTask',{taskId:question.id});
  const ask=await until(x=>x.inbox.find(i=>i.taskId===question.id&&i.kind==='question'&&i.status==='open'),'Question');
  const errStudio=await desktop.request('createStudio',{root:work,name:'Audio QA',brief:'Audio'});
  const errTask=await desktop.request('createTask',{studioId:errStudio.id,title:'Failed delivery',prompt:'QA-FORCED-ERROR'});
  await desktop.request('startTask',{taskId:errTask.id});
  await until(x=>x.inbox.find(i=>i.taskId===errTask.id&&i.kind==='error'),'Provider failure');
  await desktop.click('[data-view=workspace]');
  await shot('02-portfolio');
  const failure=(await snap()).inbox.find(i=>i.taskId===errTask.id && i.status==='open');
  await desktop.click('[data-decision="'+failure.id+'"]');await desktop.click('#dialog-actions button[type=submit]');
  await until(x=>x.inbox.find(i=>i.id===failure.id && i.readAt && i.status==='open'),'Reading an error leaves the blocker open');
  await desktop.click('[data-inbox="'+failure.id+'"]');await desktop.click('[data-retry-from-inbox]');
  await until(x=>x.inbox.find(i=>i.taskId===errTask.id && i.kind==='error' && i.id!==failure.id && i.status==='open'),'Retry reports its actual outcome');
  if(process.env.HEARTH_QA_TODAY==='1'){
    await desktop.click('[data-view=today]');await desktop.click('[data-today-id="'+ask.id+'"]');
    await until(x=>x.studios.find(studio=>studio.id===book.id)?.activeAttempts===0,'Question provider has stopped');
    await desktop.request('setStudioArchived',{studioId:book.id,archived:true});
    await eventually(()=>desktop.evaluate(()=>!document.querySelector('#dialog').open),'Archived studio closes a stale question');
    await desktop.request('setStudioArchived',{studioId:book.id,archived:false});
    await desktop.click('[data-today-id="'+ask.id+'"]');
  }else{
    await desktop.click('[data-view=workspace]');await desktop.click('[data-decision="'+ask.id+'"]');
  }
  await choose('[name=answer]','Подтверждаю QA T-17'); await desktop.click('#dialog-actions button[type=submit]');
  await until(x=>x.tasks.find(t=>t.id===question.id&&t.status==='completed'),'Text result');
  for(const task of studioInterfaceFixture())await desktop.request('createTask',{studioId:s.id,...task});
  assert.equal((await snap()).tasks.filter(t=>t.studioId===s.id).length,42);
  await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+s.id+'"]');
  await desktop.click('[data-view=work]');
  const original=await until(x=>x.tasks.find(t=>t.studioId===s.id&&t.gitDelivery?.status==='merged'&&!t.packageMembers),'Find work');
  await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
  if(process.env.HEARTH_QA_RESIZE==='1'){
    const width=await dragHorizontal('#owner-resize','#owner-inspector',-75);
    await desktop.click('[data-owner-close]');
    await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
    await eventually(()=>desktop.evaluate(expected=>Math.abs(document.querySelector('#owner-inspector').getBoundingClientRect().width-expected)<1,width),'Saved inspector width');
    console.log('PASS native drag of dialog edge and inspector divider, intermediate widths and restore');
  }
  await desktop.click('#owner-body [data-epic-link]');await desktop.click('[data-owner-back]');
  assert.equal(await desktop.evaluate(()=>document.querySelector('#owner-title').textContent),original.title);
  await choose('#owner-comment textarea','Owner QA note');await desktop.click('#owner-comment button');
  await until(x=>x.conversationMessages.some(m=>m.kind==='comment'&&m.text==='Owner QA note'),'Persistent comment');
  await shot('03-task-inspector');
  await desktop.click('[data-owner-close]');
  await desktop.evaluate(id=>[...document.querySelectorAll('[data-registry-rows] [data-task]')].find(b=>b.dataset.task===id).focus(), original.id);
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await eventually(()=>desktop.evaluate(()=>document.activeElement.id==='owner-title'),'Keyboard opens inspector');
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await eventually(()=>desktop.evaluate(id=>document.activeElement.dataset.task===id,original.id),'Focus back to selected row');
  const returnToWork=async()=>{
    await desktop.click('[data-view="workspace"]');
    await desktop.click('[data-enter-studio="'+s.id+'"]');
    await desktop.click('[data-view="work"]');
  };
  for(const [lang,title] of [['ru','Реестр задач'],['es','Registro de tareas'],['fr','Registre des tâches'],['zh-Hans','任务列表'],['en','Task register']]){
    await appLocale(lang);
    await returnToWork();
    await eventually(()=>desktop.evaluate(s=>document.querySelector('[data-work-tab=registry]')?.textContent===s,title),'Registry language '+lang);
  }
  await appLocale('ru');
  await returnToWork();
  await desktop.rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-color-scheme',value:'light'}]});
  await shot('04-light-register');
  if(process.env.HEARTH_QA_ZOOM==='1'){
    await desktop.setZoom(2);
    await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
    assert.ok(await desktop.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await desktop.click('[data-owner-close]');
    await desktop.screenshot('zoom-200');
    await desktop.setZoom(1);
    console.log('PASS native Electron 200% zoom, reachable detail and return');
  }
  await desktop.rpc('Emulation.setDeviceMetricsOverride',{width:590,height:760,deviceScaleFactor:1,mobile:false});
  await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
  assert.ok(await desktop.evaluate(()=>document.querySelector('#content').getBoundingClientRect().width===0));
  await shot('05-narrow-inspector');
  const ax=await desktop.rpc('Accessibility.getFullAXTree');
  assert.ok(ax.nodes.some(n=>n.role?.value==='heading' && n.name?.value===original.title));
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await desktop.rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await eventually(()=>desktop.evaluate(()=>document.querySelector('#owner-inspector').hidden),'Escape returns to register');
  if(process.env.HEARTH_QA_TODAY==='1'){
    await desktop.rpc('Emulation.clearDeviceMetricsOverride');
    await desktop.click('[data-view=workshop]');
    await desktop.click('main [data-owner-agent]');
    await eventually(()=>desktop.evaluate(()=>document.querySelector('#owner-title')?.textContent==='Директор'),'Role opens from team');
    await desktop.click('[data-owner-close]');
    await desktop.click('[data-team-toggle]');
    assert.ok(await desktop.evaluate(()=>document.querySelector('.work-map canvas[data-room]')));
    await desktop.click('[data-view=settings]');
    if(await desktop.evaluate(()=>!document.querySelector('#advanced').open))await desktop.click('#advanced summary');
    await desktop.click('#advanced [data-view=skills]');
    assert.equal(await desktop.evaluate(()=>document.querySelector('main h1').textContent),'Библиотека');
    await desktop.click('[data-view=work]');
    await desktop.click('[data-work-tab=artifacts]');
    assert.ok(await desktop.evaluate(()=>document.querySelector('[data-file-query]')));
    await desktop.click('[data-view=app-settings]');
    await choose('[name=density]','roomy');
    assert.equal(await desktop.evaluate(()=>document.documentElement.dataset.density),'roomy');
    console.log('PASS команда и мастерская, библиотека, поиск артефактов и плотность');
  }
  assert.deepEqual(desktop.errors,[]);
  await quitDesktop(desktop);
  desktop=await launch();
  const restored=await snap();
  assert.equal(restored.appLocale,'ru');
  assert.equal(restored.studios.length,3);
  if(process.env.HEARTH_QA_TODAY==='1')assert.equal(await desktop.evaluate(()=>document.documentElement.dataset.density),'roomy');
  assert.ok(restored.conversationMessages.some(m=>m.text==='Owner QA note'));
  assert.equal(ref(),item.review.delivery.revision.candidateOid);
  if (process.env.HEARTH_QA_REVEAL==='1') {
    const proof=restored.evidence.find(e=>e.kind==='review-diff' && item.review.evidenceIds.includes(e.id));
    assert.ok(proof,'Missing archived diff after merge, cleanup and restart');
    const result=await desktop.request('revealEvidence',{studioId:s.id,evidenceId:proof.id});
    assert.ok(result.name);
    console.log('PASS native reveal request for archived diff',result.name,'fallback:',result.parentOpened);
  }
  console.log('PASS three studios, text answer, restored state, five locales, inspector and package');
} catch(error) {
  if(desktop.child.exitCode===null) {
    console.error('Test UI state:',await desktop.evaluate(()=>({focus:document.activeElement?.outerHTML.slice(0,300),
      dialog:document.querySelector('#dialog').open,inspector:document.querySelector('#owner-inspector').hidden,inspectorTitle:document.querySelector('#owner-title').textContent,
      message:document.querySelector('#dialog-error').textContent})).catch(()=>null));
    await shot('failure').catch(()=>{});
  }
  throw error;
} finally {await desktop.close();await rm(parent,{recursive:true,force:true});}
