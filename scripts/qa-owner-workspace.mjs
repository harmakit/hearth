import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await eventually(() => evaluate(() => Boolean(window.hearth && document.querySelector('main .page-heading') && document.querySelector('#app-locale option[value=ru]'))), 'Renderer did not load');
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
try {
  if(process.env.HEARTH_QA_LOCALE){
    const locale=process.env.HEARTH_QA_LOCALE;
    await choose('#app-locale',locale);
    await eventually(()=>desktop.evaluate(l=>document.documentElement.lang===l,locale),'Initial language '+locale);
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
  await desktop.click('[data-view=inbox]');await desktop.click('[data-inbox="'+item.id+'"]');
  await shot('01-package-acceptance');
  await desktop.click('#dialog-actions button[type=submit]');
  await until(x=>x.sprints.some(sp=>sp.studioId===s.id&&sp.status==='completed'),'Sprint completion');
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
  await desktop.click('[data-view=workspace]');
  await desktop.click('[data-decision="'+ask.id+'"]');
  await choose('[name=answer]','Подтверждаю QA T-17'); await desktop.click('#dialog-actions button[type=submit]');
  await until(x=>x.tasks.find(t=>t.id===question.id&&t.status==='completed'),'Text result');
  for(let i=1;i<=36;i++)await desktop.request('createTask',{studioId:s.id,title:'Chapter '+i,prompt:'Edit chapter '+i});
  await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+s.id+'"]');
  await desktop.click('[data-view=work]');
  const original=await until(x=>x.tasks.find(t=>t.studioId===s.id&&t.gitDelivery?.status==='merged'&&!t.packageMembers),'Find work');
  await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
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
  for(const [lang,title] of [['ru','Реестр задач'],['es','Registro de tareas'],['fr','Registre des tâches'],['zh-Hans','任务列表'],['en','Task register']]){
    await choose('#app-locale',lang);
    await eventually(()=>desktop.evaluate(s=>document.querySelector('[data-work-tab=registry]')?.textContent===s,title),'Registry language '+lang);
  }
  await choose('#app-locale','ru');
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
  assert.deepEqual(desktop.errors,[]);
  const exit=new Promise(resolve=>desktop.child.once('exit',resolve));
  const pid=Number(desktop.child.pid);
  assert.ok(Number.isSafeInteger(pid) && pid>0);
  execFileSync('/usr/bin/osascript',['-l','JavaScript','-e',
    "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier("+pid+").terminate"]);
  const stopped=await Promise.race([exit.then(()=>true),delay(15000).then(()=>false)]);
  assert.equal(stopped,true,'The isolated application did not finish the native Quit request');
  await desktop.close();
  desktop=await launch();
  const restored=await snap();
  assert.equal(restored.appLocale,'ru');
  assert.equal(restored.studios.length,3);
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
