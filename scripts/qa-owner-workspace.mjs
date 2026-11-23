import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod,cp,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioInterfaceFixture } from '../test/fixtures/studio-interface.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = await (async()=>{await mkdir(join(root,'.tmp'),{recursive:true});return mkdtemp(join(root,'.tmp','owner-qa-'));})();
console.log('QA profile:', run);
const [profile, work, editorial, home, bin] = ['profile','git-work','editorial','home','bin'].map(p => join(run, p));
let workingProfile=profile;
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
  const profile=workingProfile;
  const inspectMain = process.env.HEARTH_QA_ZOOM === '1' || process.env.HEARTH_QA_QUEUE === '1';
  const child = spawn(bundle || require('electron'), [...(bundle ? [] : [root]), ...(inspectMain ? ['--inspect=127.0.0.1:0'] : []), '--remote-debugging-port=0', '--user-data-dir=' + profile], {
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
    async function mainEval(expression) {
      assert.ok(mainInspector,'No main inspector in the isolated QA process');
      const control=new WebSocket(mainInspector);
      try {
        await new Promise((res,rej)=>{control.onopen=res;control.onerror=rej;});
        const reply=new Promise((res,rej)=>{control.onmessage=e=>{
          const message=JSON.parse(e.data);
          if(message.id===1)message.error || message.result?.exceptionDetails ? rej(new Error(JSON.stringify(message))) : res(message.result.result.value);
        };});
        control.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
        return await reply;
      } finally {control.close();}
    }
    async function setZoom(factor) {
      assert.ok([1,2].includes(factor));
      assert.equal(await mainEval(`(()=>{const w=process.getBuiltinModule('module').createRequire(process.cwd()+'/qa.cjs')('electron').BrowserWindow.getAllWindows()[0].webContents; w.setZoomFactor(${factor});return w.getZoomFactor();})()`),factor);
    }
    return { child, evaluate, set, request, click, errors, screenshot, close, rpc, setZoom,mainEval };
  } catch (error) { await close(); throw error; }
}


let desktop=await launch();
const {rm,realpath}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const parent=await realpath(await mkdtemp(join(tmpdir(),'hearth-qa-new-')));
const snap=()=>desktop.request('snapshot');
const shot=name=>desktop.screenshot(name);
const choose=async(sel,value)=>{await desktop.set(sel,value);};
async function sendDirector(option, edited) {
  const before=(await snap()).conversationMessages.filter(row=>row.directorInbox).length;
  await desktop.click(`[data-inbox-suggestion="${option}"]`);
  assert.ok(await desktop.evaluate(()=>document.activeElement.name==='directorReply' && document.activeElement.value.trim()));
  assert.equal((await snap()).conversationMessages.filter(row=>row.directorInbox).length,before,'Option only fills the editor');
  if (edited !== undefined) await choose('[name=directorReply]',edited);
  await desktop.click('[data-director-send]');
}
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

async function emulateMotion(value) {
  await desktop.rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]});
}

async function checkDialogMotion() {
  await desktop.click('[data-view="workspace"]');
  await emulateMotion('no-preference');
  const pointer=await desktop.evaluate(() => {
    const {x,y,width,height}=document.querySelector('main [data-open="studio"]').getBoundingClientRect();
    return {x:x+width/2,y:y+height/2,width,height};
  });
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:pointer.x,y:pointer.y,button:'none'});
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:pointer.x,y:pointer.y,button:'left',buttons:1,clickCount:1});
  const press=await desktop.evaluate(() => {
    const button=document.querySelector('main [data-open="studio"]');
    const adjust=button.getAnimations().find(animation=>animation.transitionProperty==='box-shadow');
    adjust?.finish();
    const {width,height}=button.getBoundingClientRect();
    return {active:button.matches(':active'),outline:getComputedStyle(button).boxShadow,duration:adjust?.effect.getTiming().duration,width,height};
  });
  await desktop.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:0,y:0,button:'left',clickCount:1});
  assert.ok(press.active && press.outline!=='none' && press.duration===100,'Press responds within 100 ms');
  assert.deepEqual([press.width,press.height],[pointer.width,pointer.height],'Press keeps control geometry');
  const result=await desktop.evaluate(async () => {
    const {clearStudioDraft}=await import('hearth://app/studio-draft.mjs');
    const trigger=document.querySelector('main [data-open="studio"]');
    const dialog=document.querySelector('#dialog');
    const animations=()=>dialog.getAnimations().map(animation=>animation.transitionProperty);
    const bounds=element=>element.getBoundingClientRect().toJSON();
    const dismiss=()=>dialog.querySelector('.dialog-heading [data-close]').click();
    trigger.focus();
    const before=bounds(trigger);
    trigger.click();
    const immediate=dialog.open && dialog.contains(document.activeElement);
    const opening=animations();
    for(const animation of dialog.getAnimations()) animation.finish();
    const dialogGeometry=bounds(dialog);
    dialog.querySelector('[name="name"]').value='Motion QA';
    dialog.querySelector('[name="brief"]').value='Motion QA';
    dialog.querySelector('[name="firstResult"]').value='Motion QA';
    dialog.querySelector('[data-wizard-next]').click();
    const reused=dialog.open && Boolean(dialog.querySelector('[data-wizard-step="1"]:not([hidden])')) && animations().length===0;
    dismiss();
    const focusReturned=document.activeElement===trigger;
    const closed=!dialog.open;
    const closing=animations();
    const unblocked=document.elementFromPoint(before.x+before.width/2,before.y+before.height/2)?.closest('button')===trigger;
    const unchanged=bounds(trigger).width===before.width;
    clearStudioDraft(localStorage);
    return {immediate,opening,reused,focusReturned,closed,closing,unblocked,unchanged,dialogGeometry};
  });
  assert.ok(result.immediate,'Opening focuses the native modal dialog immediately');
  assert.ok(result.opening.includes('opacity'),'Dialog opening transitions opacity');
  assert.ok(result.reused,'Updating an open dialog does not replay its entrance');
  assert.ok(result.closed && result.focusReturned,'Closing returns focus immediately');
  assert.ok(result.closing.includes('opacity'),'Dialog closing transitions opacity');
  assert.ok(result.unblocked && result.unchanged,'Closing unblocks the window immediately without moving controls');
  assert.ok(result.dialogGeometry.width>0);

  await emulateMotion('reduce');
  await desktop.evaluate(() => document.querySelector('main [data-open="studio"]').focus());
  for (const type of ['keyDown','keyUp']) await desktop.rpc('Input.dispatchKeyEvent',{
    type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{}),
  });
  const reduced=await desktop.evaluate(() => {
    const dialog=document.querySelector('#dialog');
    return {open:dialog.open,focused:dialog.contains(document.activeElement),
      duration:getComputedStyle(dialog).transitionDuration,
      reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
      transitions:dialog.getAnimations().map(animation=>animation.transitionProperty)};
  });
  assert.deepEqual(reduced,{open:true,focused:true,duration:'0s',reduced:true,transitions:[]},'Reduced motion keeps immediate keyboard focus and omits dialog transitions');
  for (const type of ['keyDown','keyUp']) await desktop.rpc('Input.dispatchKeyEvent',{
    type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27,
  });
  await eventually(()=>desktop.evaluate(() => !document.querySelector('#dialog').open && document.activeElement.matches('main [data-open="studio"]')),'Escape restores focus with reduced motion');
  await emulateMotion('no-preference');
  console.log('PASS native press and dialog transitions, immediate focus, hit testing and reduced motion');
}

async function checkOutcomeMotion() {
  const appeared=await desktop.evaluate(() => globalThis.motionOutcomeAppeared?.label);
  assert.ok(appeared,'New confirmed result receives local feedback');
  await desktop.evaluate(() => {
    const outcome=document.querySelector('.today-outcome');
    outcome.querySelector('[data-today-next]').focus();
    globalThis.motionOutcomeNode=outcome;
    globalThis.motionNavigationNode=document.querySelector('#workspace-navigation button');
  });
  await desktop.request('setAppLocale',{locale:(await snap()).appLocale});
  await eventually(()=>desktop.evaluate(()=>document.querySelector('#workspace-navigation button')!==globalThis.motionNavigationNode),'Unchanged snapshot rendered');
  const retained=await desktop.evaluate(() => {
    const outcome=document.querySelector('.today-outcome');
    return {sameNode:outcome===globalThis.motionOutcomeNode,focused:outcome.contains(document.activeElement),
      samePulse:outcome.getAnimations().includes(globalThis.motionOutcomeAppeared.pulse),
      label:outcome.querySelector('[role="status"] strong').textContent};
  });
  assert.deepEqual(retained,{sameNode:true,focused:true,samePulse:true,label:appeared},'Result node, focus, and active pulse survive a snapshot');
  await desktop.evaluate(() => {
    globalThis.motionOutcomeMedia=matchMedia('(prefers-reduced-motion: reduce)');
    globalThis.motionOutcomeMedia.addEventListener('change',()=>{globalThis.motionOutcomeMediaChanged=true;},{once:true});
  });
  await emulateMotion('reduce');
  const motionAfterReduction=()=>desktop.evaluate(() => {
    const outcome=document.querySelector('.today-outcome');
    return {sameNode:outcome===globalThis.motionOutcomeNode, label:outcome?.querySelector('[role="status"] strong')?.textContent,
      reduced:globalThis.motionOutcomeMedia.matches, changed:Boolean(globalThis.motionOutcomeMediaChanged),
      animations:outcome?.getAnimations().map(animation=>animation.playState)};
  });
  await eventually(async()=>{
    const {sameNode,label,reduced,animations}=await motionAfterReduction();
    return sameNode && label===appeared && reduced && !animations.length;
  },'Reducing motion cancels the active pulse and leaves the status').catch(async error=>{
    throw new Error(`${error.message} ${JSON.stringify(await motionAfterReduction())}`,{cause:error});
  });
  await emulateMotion('no-preference');
  await desktop.click('[data-view=workspace]');
  await desktop.click('[data-view=today]');
  assert.ok(await desktop.evaluate(() => {
    const outcome=document.querySelector('.today-outcome');
    return outcome && !outcome.getAnimations().length;
  }),'Returning to Today does not replay the result');
  console.log('PASS confirmed Today transition, persistent result and no replay on navigation');
}

async function checkInspectorMotion(taskId) {
  const opened=await desktop.evaluate(id => {
    const inspector=document.querySelector('#owner-inspector');
    const trigger=[...document.querySelectorAll('[data-registry-rows] [data-task]')].find(button=>button.dataset.task===id);
    trigger.focus();
    trigger.click();
    const [entrance]=inspector.getAnimations();
    entrance?.finish();
    globalThis.motionNavigationNode=document.querySelector('#workspace-navigation button');
    return {focus:document.activeElement.id,transition:entrance?.transitionProperty};
  },taskId);
  assert.deepEqual(opened,{focus:'owner-title',transition:'opacity'});
  await desktop.request('setAppLocale',{locale:(await snap()).appLocale});
  await eventually(()=>desktop.evaluate(()=>document.querySelector('#workspace-navigation button')!==globalThis.motionNavigationNode),'Snapshot rendered while inspector open');
  assert.ok(await desktop.evaluate(() => document.activeElement.id==='owner-title' && !document.querySelector('#owner-inspector').getAnimations().length));
  console.log('PASS inspector fades on first opening and retains focus through live snapshots');
}

try {
  if(process.env.HEARTH_QA_LOCALE){
    await appLocale(process.env.HEARTH_QA_LOCALE);
    await desktop.click('[data-view="workspace"]');
  }
  if(process.env.HEARTH_QA_HINTS==='1'){
    await desktop.click('[data-view=today]');
    await eventually(()=>desktop.evaluate(()=>Boolean(document.querySelector('[data-open="studio"][aria-describedby~="onboarding-description"]'))),'Hint anchored to existing create button');
    const description=await desktop.evaluate(()=>document.querySelector('#onboarding-description').textContent);
    const accessibility=await desktop.rpc('Accessibility.getFullAXTree');
    assert.ok(accessibility.nodes.some(node=>node.role?.value==='button' && node.description?.value===description),
      'The existing button exposes the contextual description to assistive technology');
    await desktop.rpc('Emulation.setDeviceMetricsOverride',{width:590,height:470,deviceScaleFactor:1,mobile:false});
    assert.ok(await desktop.evaluate(()=>{
      const hint=document.querySelector('.onboarding-hint').getBoundingClientRect();
      return hint.width>0 && hint.left>=0 && hint.right<=innerWidth+1;
    }),'Hint fits the narrow window');
    await desktop.rpc('Emulation.clearDeviceMetricsOverride');
    await desktop.click('.onboarding-dismiss');
    assert.ok(await desktop.evaluate(()=>document.querySelector('#onboarding-confirm').open && document.activeElement.hasAttribute('data-hint-cancel')));
    await desktop.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await desktop.rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await eventually(()=>desktop.evaluate(()=>!document.querySelector('#onboarding-confirm').open && document.activeElement.classList.contains('onboarding-dismiss')),'Escape keeps hints and returns focus');
    await desktop.click('.onboarding-dismiss');
    await desktop.click('[data-hint-disable]');
    await until(view=>view.onboardingHintsEnabled===false,'Hints disabled for profile');
    await quitDesktop(desktop);
    desktop=await launch();
    assert.equal((await snap()).onboardingHintsEnabled,false);
    await desktop.click('[data-view=today]');
    assert.equal(await desktop.evaluate(()=>document.querySelector('.onboarding-hint')),null);
    await desktop.click('[data-view=app-settings]');
    await choose('[name=onboardingHints]',true);
    await until(view=>view.onboardingHintsEnabled===true,'Restore onboarding preference');
    await desktop.rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await desktop.click('[data-view=today]');
    await eventually(()=>desktop.evaluate(()=>document.querySelector('.onboarding-pointer')?.getAnimations().length===0),'Reduced motion keeps a static hint');
    await desktop.rpc('Emulation.setEmulatedMedia',{features:[]});
    await desktop.click('[data-view=workspace]');
    console.log('PASS onboarding anchor, Escape, profile persistence, settings restore and reduced motion');
  }
  if(['1','dialog'].includes(process.env.HEARTH_QA_MOTION))await checkDialogMotion();
  if (process.env.HEARTH_QA_QUEUE === '1') {
    await appLocale('ru');
    const project = join(run, 'queue-qa-project');
    await mkdir(project);
    const backlogStudio = await desktop.request('createStudio', { root:project, name:'QA: замена', wipLimit:1 });
    const backlog = { studioId:backlogStudio.id, backlog:true };
    const old = await desktop.request('createTask', { ...backlog, title:'Старая задача', prompt:'Старая.' });
    const replacement = await desktop.request('createTask', { ...backlog, title:'Новая задача', prompt:'Новая.' });
    await desktop.request('setStudioRunning', { studioId:backlogStudio.id, action:'pause' });
    await desktop.request('startTask', { taskId:old.id });
    const version = (await snap()).studios.find(row => row.id === backlogStudio.id).backlogVersion;
    await desktop.request('reviseBacklog', { studioId:backlogStudio.id, baseVersion:version, edits:[
      { type:'replace', taskId:old.id, replacementId:replacement.id },
    ] });
    await desktop.request('startTask', { taskId:replacement.id });
    await desktop.request('setStudioRunning', { studioId:backlogStudio.id, action:'resume' });
    await until(view => view.tasks.find(row => row.id === replacement.id)?.stage === 'done', 'Replacement task finishes');
    const replaced = await snap();
    assert.equal(replaced.tasks.find(row => row.id === old.id).stage, 'replaced');
    assert.equal(replaced.attempts.some(row => row.taskId === old.id), false);
    await desktop.request('deleteStudio', { studioId:backlogStudio.id, confirmation:backlogStudio.name });

    const sprintStudio = await desktop.request('createStudio', { root:project, name:'QA: повтор шага', brief:'QA-QUEUE-SPRINT', wipLimit:5, sprintReview:'off' });
    await desktop.request('initializeStudio', { studioId:sprintStudio.id });
    const sprintPlan = await until(view => view.plans.find(row => row.studioId === sprintStudio.id && row.status === 'pending'), 'Queue sprint plan');
    await desktop.request('decidePlan', { planId:sprintPlan.id, decision:'approve' });
    const step = await until(view => view.tasks.find(row => row.studioId === sprintStudio.id && row.key === 'chapter' && row.status === 'running'), 'Chapter process');
    await eventually(() => readFile(join(run, 'qa-queue-cancelled'), 'utf8').catch(() => ''), 'First chapter provider is waiting');
    await desktop.request('cancelTask', { taskId:step.id });
    const hold = await until(view => view.inbox.find(row => row.taskId === step.id && row.kind === 'reconcile'), 'Cancelled step is held');
    await until(view => view.attempts.find(row => row.id === hold.attemptId && row.processActive === false), 'Cancelled provider exits');
    await desktop.request('resolveReconciliation', { attemptId:hold.attemptId, decision:'discard', reason:'Проверочный процесс завершился.' });
    await desktop.click('[data-view=workspace]');
    await desktop.click('[data-enter-studio="' + sprintStudio.id + '"]');
    await desktop.click('main [data-task="' + step.id + '"]');
    await desktop.click('#owner-body [data-start-task="' + step.id + '"]');
    await until(view => view.sprints.find(row => row.studioId === sprintStudio.id && row.status === 'completed'), 'Same sprint finishes after explicit retry');
    assert.match(await readFile(join(project, 'reports', 'chapter.md'), 'utf8'), /# Глава/);
    await desktop.click('[data-owner-close]');
    await desktop.request('deleteStudio', { studioId:sprintStudio.id, confirmation:sprintStudio.name });

    const stopStudio = await desktop.request('createStudio', { root:project, name:'QA: остановка процесса', brief:'QA-QUEUE-STOP' });
    await desktop.request('initializeStudio', { studioId:stopStudio.id });
    const pid = Number(await eventually(() => readFile(join(run, 'qa-queue-stop-pid'), 'utf8').catch(() => ''), 'Local fixture PID'));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    await desktop.mainEval(`(() => {
      const original = process.kill;
      globalThis.restoreQueueTestSignal = () => { process.kill = original; };
      process.kill = (target, signal) => target === -${pid} ? true : original(target, signal);
      return true;
    })()`);
    let fixtureStopped = false;
    try {
      await desktop.click('[data-view=workspace]');
      await desktop.click('[data-enter-studio="' + stopStudio.id + '"]');
      await desktop.click('[data-run-action=stop]');
      const stopHold = await until(view => view.inbox.find(row => row.studioId === stopStudio.id && row.kind === 'reconcile'), 'Stop reconciliation');
      await until(view => view.attempts.find(row => row.id === stopHold.attemptId && row.processActive && row.processUnconfirmed), 'Timeout recorded while provider is alive');
      process.kill(pid, 0);
      await desktop.click('[data-inbox="' + stopHold.id + '"]');
      assert.equal(await desktop.evaluate(() => Boolean(document.querySelector('[data-inbox-suggestion=retry]'))), false);
      await assert.rejects(desktop.request('resolveReconciliation', { attemptId:stopHold.attemptId, decision:'retry', reason:'QA', confirmProcessExited:true }), /выполняется/);
      await shot('queue-still-stopping');
      process.kill(-pid, 'SIGKILL');
      fixtureStopped = true;
      await until(view => view.attempts.find(row => row.id === stopHold.attemptId && row.processActive === false && row.processUnconfirmed === false), 'Confirmed subprocess exit');
      await sendDirector('retry');
      await until(view=>view.inbox.find(row=>row.id===stopHold.id&&row.status==='resolved'),'Director queues a verified retry');
      await desktop.click('#dialog-actions [data-close]');
      await desktop.click('[data-run-action=resume]');
      await until(view => view.plans.find(row => row.studioId === stopStudio.id && row.status === 'pending'), 'Retry succeeds after exit');
    } finally {
      await desktop.mainEval('globalThis.restoreQueueTestSignal()');
      if (!fixtureStopped) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await desktop.request('deleteStudio', { studioId:stopStudio.id, confirmation:stopStudio.name });
    await desktop.click('[data-view=workspace]');
    console.log('PASS замена карточки, повтор прерванной задачи в том же спринте, блокировка на живом процессе до подтверждения выхода');
  }
  if (process.env.HEARTH_QA_COACH_EXERCISE === '1') {
    await appLocale('ru');
    const project = join(run, 'coach-exercise-project');
    await mkdir(project);
    const studio = await desktop.request('createStudio', { root: project, name:'QA: упражнение коуча', brief:'QA-COACH-EXERCISE', wipLimit:5 });
    const coach = studio.agents.find(agent => agent.systemRole === 'coach');
    const hire = await desktop.request('addAgent', { studioId:studio.id, role:'editor', name:'QA: редактор' });
    const work = await desktop.request('createTask', { studioId:studio.id, agentId:hire.id, title:'QA: правка текста', prompt:'Проверить черновик.' });
    const coachTask = snapshot => snapshot.tasks.find(task => task.id === coach.trainingTaskId);
    await desktop.request('startTask', { taskId:work.id });
    await until(snapshot => coachTask(snapshot).status === 'failed', 'Malformed coach answer must leave a retryable failure');
    const blocked = await snap();
    assert.equal(blocked.studios.find(row => row.id === studio.id).activeAttempts, 0);
    assert.equal(blocked.tasks.find(row => row.id === work.id).stage, 'backlog');
    assert.equal(blocked.attempts.some(row => row.taskId === coach.trainingTaskId && row.purpose === 'review'), false);

    await desktop.request('updateStudio', { studioId:studio.id, schedule:{ enabled:true, days:[(new Date().getDay() + 1) % 7], start:'09:00', end:'18:00' } });
    assert.ok((await snap()).studios.find(row => row.id === studio.id).scheduleWaiting);
    await desktop.click('[data-view=workspace]');
    await eventually(() => desktop.evaluate(id => document.querySelector('[data-enter-studio="' + id + '"]').closest('header').textContent.includes('Нужно внимание'), studio.id), 'Workspace must show the failure');
    await desktop.click('[data-enter-studio="' + studio.id + '"]');
    await eventually(() => desktop.evaluate(() => document.querySelector('main .split .status')?.textContent.includes('Требуется внимание')), 'Overview must show attention at zero active attempts');
    assert.doesNotMatch(await desktop.evaluate(() => document.querySelector('main .activity').textContent), /Агент выполняет/);
    await desktop.click('main [data-task="' + coach.trainingTaskId + '"]');
    await eventually(() => desktop.evaluate(() => document.querySelector('#owner-body .task-recovery')?.textContent.includes('Агент вернул пустой результат')), 'Exercise failure explains the bad reply');
    await shot('coach-exercise-failed');
    await desktop.request('updateStudio', { studioId:studio.id, schedule:{ enabled:false } });
    await desktop.click('#owner-body .task-recovery [data-retry-from-inbox]');
    await until(snapshot => snapshot.tasks.find(task => task.id === work.id).stage === 'done', 'Retry must unblock the dependent assignment');
    const done = await snap();
    assert.match(coachTask(done).training.exercise, /не допускать навык/);
    assert.equal(coachTask(done).review, 'QA: директор проверил решение по лицензии.');
    assert.equal(done.tasks.find(task => task.id === hire.trainingTaskId).stage, 'done');
    assert.deepEqual(done.attempts.filter(row => row.taskId === coach.trainingTaskId && row.purpose === 'training-exercise').map(row => row.calls?.length), [2, 2]);
    await shot('coach-exercise-approved');
    await desktop.click('[data-owner-close]');
    await desktop.request('deleteStudio', { studioId:studio.id, confirmation:studio.name });
    await desktop.click('[data-view=workspace]');
    console.log('PASS ответ коуча → ошибка без ложного статуса → повтор → проверка директором → завершение зависимой задачи');
  }
  if (process.env.HEARTH_QA_COACH_SPRINT === '1') {
    await appLocale('ru');
    await choose('#theme-select', 'dark');
    const root = join(run, 'coach-sprint-project');
    await mkdir(root);
    const studio = await desktop.request('createStudio', { root, name:'QA: первый спринт', brief:'QA-COACH-SPRINT', wipLimit:5, sprintReview:'off' });
    const coachId = studio.agents.find(agent => agent.systemRole === 'coach').trainingTaskId;
    await desktop.request('initializeStudio', { studioId:studio.id });
    const plan = await until(snapshot => snapshot.plans.find(row => row.studioId === studio.id && row.status === 'pending'), 'Coach sprint plan');
    await desktop.request('decidePlan', { planId:plan.id, decision:'approve' });
    await until(snapshot => snapshot.tasks.find(row => row.id === coachId && row.failedReviews === 3 && row.status === 'failed'), 'Director returned the coach three times');
    await assert.rejects(readFile(join(root, 'reports', 'chapter.md')), { code:'ENOENT' });
    await desktop.click('[data-view=workspace]');
    await desktop.click('[data-enter-studio="' + studio.id + '"]');
    await desktop.click('main [data-retry-from-inbox="' + coachId + '"]');
    await until(snapshot => snapshot.sprints.find(row => row.studioId === studio.id && row.status === 'completed'), 'Coach retry continues the original sprint', 100_000);
    assert.match(await readFile(join(root, 'reports', 'chapter.md'), 'utf8'), /# Глава/);
    assert.match(await readFile(join(root, 'reports', 'art.md'), 'utf8'), /# Иллюстрация/);

    await desktop.click('main [data-view=workshop], [data-view=workshop]');
    if (await desktop.evaluate(() => !document.querySelector('.work-map'))) await desktop.click('[data-team-toggle]');
    assert.ok(await desktop.evaluate(() => ['director','library','atelier'].every(zone => {
      const canvas = document.querySelector('.work-room[data-zone="' + zone + '"] canvas[data-room]');
      const [r,g,b,a] = canvas.getContext('2d').getImageData(4, 10, 1, 1).data;
      return a === 255 && b > g && g > r;
    })));
    await shot('graphite-workshop');
    await desktop.click('main .map-pin:first-child');
    await eventually(() => desktop.evaluate(() => !document.querySelector('#owner-inspector').hidden), 'Map opens the agent profile');
    await desktop.click('[data-owner-close]');
    await desktop.click('[data-team-toggle]');
    await desktop.request('deleteStudio', { studioId:studio.id, confirmation:studio.name });
    await desktop.click('[data-view=app-settings]');
    await choose('#theme-select', 'system');
    await desktop.click('[data-view=workspace]');
    console.log('PASS повтор коуча продолжает тот же спринт и публикует файлы, графитовая карта открывает профили агентов');
  }
  if(process.env.HEARTH_QA_POLISH==='1'){
    await desktop.click('[data-view=app-settings]');
    await choose('#theme-select','dark');
    assert.ok(await desktop.evaluate(()=>{
      const cards=[...document.querySelectorAll('.provider-card')];
      const gap=card=>card.querySelector('h3').getBoundingClientRect().left-card.getBoundingClientRect().left;
      return cards.length===2&&cards.every(card=>gap(card)>=12)&&Math.abs(cards[0].querySelector('.provider-card-actions').getBoundingClientRect().bottom-cards[1].querySelector('.provider-card-actions').getBoundingClientRect().bottom)<2;
    }));
    await shot('provider-spacing');
    await desktop.click('[data-open=app-model-policy]');
    assert.match(await desktop.evaluate(()=>getComputedStyle(document.querySelector('#dialog'),'::backdrop').backgroundColor),/rgba?\(8, 12, 18/);
    await shot('neutral-models-dialog');
    await desktop.click('#dialog-actions [data-close]');
    await choose('#theme-select','system');
    const scratch=await desktop.request('createStudio',{root:editorial,name:'Coach failure QA',brief:'QA-COACH-REJECT',wipLimit:5});
    const coach=scratch.agents.find(agent=>agent.systemRole==='coach');
    await desktop.request('startTask',{taskId:coach.trainingTaskId});
    const blocked=await until(x=>x.tasks.find(t=>t.id===coach.trainingTaskId&&t.status==='failed'),'Coach needs recovery');
    await until(x=>x.studios.find(s=>s.id===scratch.id)?.activeAttempts===0,'Coach finished');
    await desktop.request('setStudioRunning',{studioId:scratch.id,action:'pause'});
    await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+scratch.id+'"]');
    await desktop.click('main [data-task="'+blocked.id+'"]');
    await desktop.click('#owner-body .task-recovery [data-run-action=resume]');
    await eventually(()=>desktop.evaluate(()=>Boolean(document.querySelector('#owner-body .task-recovery [data-retry-from-inbox]'))),'Resume retains the retry action');
    assert.ok((await snap()).inbox.some(item=>item.taskId===blocked.id&&item.status==='open'));
    await desktop.click('#owner-body .task-recovery summary');
    await shot('coach-recovery');
    await desktop.click('[data-owner-close]');
    await desktop.request('deleteStudio',{studioId:scratch.id,confirmation:scratch.name});
    await desktop.click('[data-view=workspace]');
    console.log('PASS нейтральный каталог, отступы подключений, объяснение ошибки и повтор после возобновления');
  }
  if(process.env.HEARTH_QA_ONBOARDING_FIX==='1'){
    await appLocale('ru');
    assert.equal(await desktop.evaluate(()=>document.querySelectorAll('[data-settings-locale], #app-locale').length),1);
    await desktop.click('[data-view="workspace"]');
    const plain=join(parent,'guys inc');
    await mkdir(plain);
    await writeFile(join(plain,'existing.md'),'Owner draft');
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
    await eventually(()=>desktop.evaluate(()=>document.querySelector('#dialog-actions button[type=submit]')?.textContent==='Создать локальный репозиторий'),'Offer to create local Git');
    assert.throws(()=>execFileSync('git',['-C',plain,'rev-parse','--git-dir'],{stdio:'ignore'}),{status:128});
    await desktop.click('#dialog-actions button[type=submit]');
    await until(s=>s.studios.find(row=>row.id===created.id && row.projectGit?.enabled),'Local Git is connected');
    await eventually(()=>desktop.evaluate(()=>!document.querySelector('#dialog').open),'Git setup closes after success');
    assert.equal(execFileSync('git',['-C',plain,'ls-files'],{encoding:'utf8'}).trim(),'');
    assert.equal(await readFile(join(plain,'existing.md'),'utf8'),'Owner draft');
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
    await sendDirector('retry');
    await until(s=>s.inbox.find(i=>i.id===hold.id && i.status==='resolved'),'Retry placed in queue');
    await desktop.click('#dialog-actions [data-close]');
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
  let s=await until(x=>x.studios.find(s=>s.name==='Edition' && (process.env.HEARTH_QA_PORTABLE!=='1' || s.portable)),
    'Create new project and finish setting up project storage');
  assert.ok(s.projectGit.enabled);
  await desktop.click('[data-initialize]');
  const plan=await until(x=>x.plans.find(p=>p.studioId===s.id&&p.status==='pending'),'Director plan');
  await desktop.click('[data-plan="'+plan.id+'"]');
  if(process.env.HEARTH_QA_HINTS==='1'){
    await choose('[name=directorReply]','Черновик примечания');
    await desktop.click('#dialog .onboarding-dismiss');
    assert.ok(await desktop.evaluate(()=>document.querySelector('#dialog').open && document.querySelector('#onboarding-confirm').open));
    await desktop.click('[data-hint-cancel]');
    assert.equal(await desktop.evaluate(()=>document.querySelector('[name=directorReply]').value),'Черновик примечания');
    console.log('PASS nested onboarding confirmation preserves the plan and typed reply');
  }
  if(process.env.HEARTH_QA_MOTION==='1')await desktop.evaluate(() => {
    const dialog=document.querySelector('#dialog');
    for(const animation of dialog.getAnimations()) animation.finish();
    globalThis.motionPlanBody=document.querySelector('#dialog-body').firstElementChild;
  });
  await desktop.click('[data-edit-plan-tasks]');
  if(process.env.HEARTH_QA_MOTION==='1')assert.ok(await desktop.evaluate(() => {
    const dialog=document.querySelector('#dialog');
    return dialog.open && document.querySelector('#dialog-body').firstElementChild!==globalThis.motionPlanBody && !dialog.getAnimations().length;
  }),'Replacing the contents of a visible dialog does not animate a new entrance');
  await choose('[name=sprintReview]','hold');
  await choose('[name=accept0]',false);
  await desktop.click('#dialog-actions button[type=submit]');
  await sendDirector('approve');
  await until(view=>view.plans.find(row=>row.id===plan.id&&row.status==='approved'),'Director applies plan approval');
  await desktop.click('#dialog-actions [data-close]');
  const stateAtDecision=await until(x=>x.inbox.some(i=>i.review?.members?.length && i.status==='open')?x:null,'Held sprint acceptance',180000);
  const item=stateAtDecision.inbox.find(i=>i.review?.members?.length && i.status==='open');
  const base=execFileSync('git',['-C',s.root,'rev-parse','main'],{encoding:'utf8'}).trim();
  const target=s.projectGit.targetRef;
  const ref=()=>execFileSync('git',['-C',s.root,'rev-parse',target],{encoding:'utf8'}).trim();
  assert.equal(ref(),base);
  let sourceRoot;
  let gitRecipeRoot;
  if(process.env.HEARTH_QA_PORTABLE==='1'){
    assert.equal(s.portable,true);
    sourceRoot=s.root;
    const task=stateAtDecision.tasks.find(row=>row.studioId===s.id&&row.gitDelivery?.worktreeId&&!row.packageMembers);
    const relativeTree=join('.hearth','worktrees',task.gitDelivery.worktreeId);
    await writeFile(join(sourceRoot,relativeTree,'uncommitted-draft.txt'),'Source draft');
    await desktop.request('prepareStudioCopy',{studioId:s.id});
    await quitDesktop(desktop);
    const copied=join(run,'Copied studio with spaces');
    await cp(sourceRoot,copied,{recursive:true,verbatimSymlinks:true});
    workingProfile=join(run,'copied-profile');
    await mkdir(workingProfile);
    desktop=await launch();
    assert.equal((await snap()).studios.length,0);
    const restored=await desktop.request('openStudioFolder',{root:copied});
    assert.equal(restored.id,s.id);
    assert.equal(restored.manualPaused,true);
    assert.equal((await snap()).inbox.find(row=>row.id===item.id).review.key,item.review.key);
    assert.equal(await readFile(join(copied,relativeTree,'uncommitted-draft.txt'),'utf8'),'Source draft');
    s=restored;
    await appLocale('ru');
    await desktop.request('setStudioRunning',{studioId:s.id,action:'resume'});
    await desktop.click('[data-view=workspace]');
    await desktop.click('[data-enter-studio="'+s.id+'"]');
    console.log('PASS full folder in a clean profile keeps pending approval and uncommitted changes');
  }
  if(process.env.HEARTH_QA_TODAY==='1'){
    await desktop.click('[data-view=today]');await desktop.click('[data-today-id="'+item.id+'"]');
  } else {
    await desktop.click('[data-view=inbox]');await desktop.click('[data-inbox="'+item.id+'"]');
  }
  if(process.env.HEARTH_QA_RESIZE==='1') await dragHorizontal('[data-dialog-width]','#dialog',50);
  await shot('01-package-acceptance');
  if(['1','feedback'].includes(process.env.HEARTH_QA_MOTION)) await desktop.evaluate(() => {
    const observer=new MutationObserver(() => {
      const outcome=document.querySelector('.today-outcome');
      const label=outcome?.querySelector('[role="status"] strong')?.textContent;
      const merged=document.documentElement.lang==='ru'?'Изменения слиты':'Changes merged';
      if (label!==merged) return;
      const pulse=outcome?.getAnimations()[0];
      if(!pulse)return;
      pulse.pause();
      globalThis.motionOutcomeAppeared={pulse,label};
      observer.disconnect();
    });
    observer.observe(document.querySelector('main'),{childList:true,subtree:true});
  });
  await sendDirector('approve');
  await until(x=>x.sprints.some(sp=>sp.studioId===s.id&&sp.status==='completed'),'Sprint completion');
  if(process.env.HEARTH_QA_TODAY==='1'){
    await eventually(()=>desktop.evaluate(()=>Boolean(document.querySelector('.today-outcome')?.textContent.includes(
      document.documentElement.lang==='ru'?'Изменения слиты':'Changes merged'))),'Today shows confirmed merge');
    await shot('today-real-merge');
    console.log('PASS Сегодня → решение → подтверждённое слияние');
    if(['1','feedback'].includes(process.env.HEARTH_QA_MOTION))await checkOutcomeMotion();
    await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+s.id+'"]');
  } else await desktop.click('#dialog-actions [data-close]');
  if(await desktop.evaluate(()=>!document.querySelector('#owner-inspector').hidden))await desktop.click('[data-owner-close]');
  await desktop.click('[data-view=inbox]');await desktop.click('[data-scope=resolved]');
  await desktop.click('[data-inbox="'+item.id+'"]');
  assert.ok(await desktop.evaluate(hash=>document.querySelector('#dialog-body').textContent.includes(hash),item.review.key.slice(0,12)));
  assert.equal(await desktop.evaluate(()=>Boolean(document.querySelector('#dialog-actions button[type=submit]'))),false);
  await desktop.click('#dialog-actions [data-close]');
  assert.notEqual(ref(),base);
  assert.ok(execFileSync('git',['-C',s.root,'show',target+':delivery.md'],{encoding:'utf8'}).includes('QA deliverable'));
  if(sourceRoot){
    assert.equal(execFileSync('git',['-C',sourceRoot,'rev-parse',target],{encoding:'utf8'}).trim(),base);
    execFileSync('git',['-C',s.root,'add','--','.gitignore','.hearth/studio.json','.hearth/roles','.codex/agents','.claude/agents']);
    execFileSync('git',['-C',s.root,'-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','Publish studio settings']);
    const clone=join(run,'git recipe');
    execFileSync('git',['clone','-q',s.root,clone]);
    const listing=execFileSync('git',['-C',clone,'ls-files'],{encoding:'utf8'});
    assert.match(listing,/\.hearth\/studio\.json/u);
    assert.match(listing,/\.codex\/agents\//u);
    assert.doesNotMatch(listing,/\.hearth\/(state|worktrees)\//u);
    gitRecipeRoot=clone;
    console.log('PASS copy merge does not change the original and Git clone contains only the studio recipe');
  }
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
  await desktop.click('[data-decision="'+failure.id+'"]');
  await sendDirector('explain');
  await until(x=>x.conversationMessages.find(m=>m.status==='processed'&&m.directorInbox?.inboxId===failure.id),'Director explains the error');
  assert.equal((await snap()).inbox.find(i=>i.id===failure.id).status,'open');
  const firstReply=await eventually(()=>desktop.evaluate(()=>document.querySelector('.director-replies')?.textContent),'First reply is visible');
  const followUp='Уточни, что произойдёт при повторе.';
  await sendDirector('explain',followUp);
  await until(x=>x.conversationMessages.filter(m=>m.status==='processed'&&m.directorInbox?.inboxId===failure.id).length===2,'Director answers the follow-up');
  await desktop.click('#dialog-actions [data-close]');
  await desktop.click('[data-inbox="'+failure.id+'"]');
  await eventually(()=>desktop.evaluate(({first,second})=>{
    const history=document.querySelector('.director-replies');
    return history.children.length===2 && history.textContent.startsWith(first) &&
      history.textContent.includes(second) && document.querySelector('[name=directorReply]').value==='';
  },{first:firstReply,second:followUp}),'Inbox shows every exchange after reopening and leaves a blank editor');
  await sendDirector('retry');
  await until(x=>x.inbox.find(i=>i.taskId===errTask.id && i.kind==='error' && i.id!==failure.id && i.status==='open'),'Retry reports its actual outcome');
  if (await desktop.evaluate(()=>document.querySelector('#dialog').open)) await desktop.click('#dialog-actions [data-close]');
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
  const edited='Подтверждаю QA T-17, с моим уточнением.';
  await sendDirector('suggested-0',edited);
  await until(x=>x.tasks.find(t=>t.id===question.id&&t.status==='completed'),'Text result');
  assert.equal((await snap()).conversationMessages.find(m=>m.directorInbox?.inboxId===ask.id).text,edited);
  for(const task of studioInterfaceFixture())await desktop.request('createTask',{studioId:s.id,...task});
  assert.equal((await snap()).tasks.filter(t=>t.studioId===s.id).length,42);
  await desktop.click('[data-view=workspace]');await desktop.click('[data-enter-studio="'+s.id+'"]');
  await desktop.click('[data-view=work]');
  const original=await until(x=>x.tasks.find(t=>t.studioId===s.id&&t.gitDelivery?.status==='merged'&&!t.packageMembers),'Find work');
  if(process.env.HEARTH_QA_MOTION==='1')await checkInspectorMotion(original.id);
  else await desktop.click('[data-registry-rows] [data-task="'+original.id+'"]');
  if(process.env.HEARTH_QA_POLISH==='1'){
    const clipboardExpr="process.getBuiltinModule('module').createRequire(process.cwd()+'/qa.cjs')('electron').clipboard";
    assert.equal(await desktop.mainEval(`(()=>{const board=${clipboardExpr};const original=board.writeText;
      globalThis.restoreQaClipboard=()=>{board.writeText=original;delete globalThis.qaClipboardId;};
      board.writeText=id=>{globalThis.qaClipboardId=id;};return board.writeText!==original;})()`),true);
    try {
      await desktop.click('#owner-body [data-copy-id]');
      await eventually(()=>desktop.evaluate(()=>document.querySelector('#notice').textContent==='ID задачи скопирован.'),'Native copy feedback');
      assert.equal(await desktop.mainEval('globalThis.qaClipboardId'),original.id);
      console.log('PASS кнопка ID передаёт полный идентификатор нативному буферу');
    } finally {await desktop.mainEval('globalThis.restoreQaClipboard()');}
  }
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
  if(process.env.HEARTH_QA_MOTION==='1')assert.ok(await desktop.evaluate(() =>
    document.activeElement.id==='owner-title' && !document.querySelector('#owner-inspector').getAnimations().length));
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
  if(gitRecipeRoot){
    await quitDesktop(desktop);
    workingProfile=join(run,'recipe-profile');
    await mkdir(workingProfile);
    desktop=await launch();
    const recipe=await desktop.request('openStudioFolder',{root:gitRecipeRoot});
    assert.equal(recipe.id,s.id);
    assert.equal(recipe.manualPaused,true);
    assert.equal((await snap()).sprints.length,0);
    const roleFiles=await readFile(join(gitRecipeRoot,'.hearth','roles','director.md'),'utf8');
    assert.match(roleFiles,/Coordinate this studio/u);
    await desktop.request('setStudioRunning',{studioId:recipe.id,action:'resume'});
    await desktop.request('initializeStudio',{studioId:recipe.id});
    await until(x=>x.plans.some(plan=>plan.studioId===recipe.id&&plan.status==='pending'),'Clean Git recipe starts native planning');
    assert.equal(await readFile(join(gitRecipeRoot,'.hearth','roles','director.md'),'utf8'),roleFiles);
    console.log('PASS clean Git clone opens its stored native roles and starts with fresh studio history');
  }
} catch(error) {
  if(desktop.child.exitCode===null) {
    console.error('Test UI state:',await desktop.evaluate(()=>({focus:document.activeElement?.outerHTML.slice(0,300),
      dialog:document.querySelector('#dialog').open,inspector:document.querySelector('#owner-inspector').hidden,inspectorTitle:document.querySelector('#owner-title').textContent,
      message:document.querySelector('#dialog-error').textContent})).catch(()=>null));
    await shot('failure').catch(()=>{});
  }
  throw error;
} finally {await desktop.close();await rm(parent,{recursive:true,force:true});}
