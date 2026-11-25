import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [provider, ...args] = process.argv.slice(2);
const threadId = 'c0b00000-1000-4000-a000-1000aaa00001';
const send = message => console.log(JSON.stringify(message));
const fixtureSandbox = cwd => ['-p', `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(cwd)}))`];
const archiveSource = 'https://www.nationalarchives.gov.uk/education/resources/partition-of-india/';
const failedSource = 'https://www.nationalarchives.gov.uk/hearth-qa-missing';
const researchPrompt = prompt => prompt.startsWith('Interpret the owner’s visible reply') && prompt.includes('QA-WEB-HISTORICAL');
function response(prompt) {
  if (researchPrompt(prompt)) return {
    action:'answer',text:'Поиск завершён',researchIntent:'search',webResearch:{sources:[
      {url:archiveSource,status:'found',note:null},{url:failedSource,status:'failed',note:'HTTP 404'},
    ],unverified:['Дата свидетельства']},
  };
  if (prompt.startsWith('Interpret the owner’s visible reply')) {
    const context=JSON.parse(prompt.split('\n\n').at(-1));
    const text=context.ownerReply.toLowerCase();
    const action=/^(подтверди|approve |прими|accept )/u.test(text)?'approve':
      /^(повтори|retry |возобнови|resume )/u.test(text)?'retry':
      /^(пересобери|верни|revise |return )/u.test(text)?'revise':
      text.includes('qa t-17')?'answer':'explain';
    return {action:context.allowed.includes(action)?action:'explain',text:'QA директор: '+context.ownerReply};
  }
  if(prompt.includes('QA-FORCED-ERROR')) throw new Error('QA intentional provider failure');
  if (prompt.startsWith('Propose') && /QA-(?:COACH|QUEUE)-SPRINT/.test(prompt)) return {
    title:'План с подготовкой коуча', goal:'Записать два файла',
    epic:{ title:'Сборник', description:'Временный проект.' }, story:{ title:'Глава', acceptance:'Файлы записаны.' },
    agents:[{key:'writer',role:'editor',description:'Пишет'}, {key:'reader',role:'other',description:'Проверяет'}, {key:'artist',role:'artist',description:'Иллюстрирует'}],
    tasks:[
      {key:'chapter',title:'Подготовить главу',prompt:'QA-CHAPTER-FILE',criteria:'Глава записана',agentKey:'writer',reviewerKey:'reader',artifactPath:'reports/chapter.md'},
      {key:'art',title:'Описать иллюстрацию',prompt:'QA-ART-FILE',criteria:'Описание записано',agentKey:'artist',reviewerKey:'reader',dependsOn:['chapter'],artifactPath:'reports/art.md'},
    ],
    files:[],
  };
  if (prompt.startsWith('Propose')) return {
    title:'План QA', goal:'Проверить Git-доставку',
    epic:{ title:'Git-доставка',description:'Только фикстура.' }, story:{title:'Результат QA',acceptance:'Файл проверен.'},
    agents:[{key:'maker',role:'engineer',description:'Правит файлы'},{key:'reader',role:'other',description:'Проверяет изменения'}],
    tasks:[/QA-(?:STOP-PLAN|QUEUE-STOP)/.test(prompt)
      ? {key:'first-text',title:'Первая глава',prompt:'Подготовить текст',criteria:'Черновик готов',agentKey:'maker',reviewerKey:'reader'}
      : {key:'git-file',title:'Git доставка QA',prompt:'QA-GIT-EDIT',criteria:'Файл проверен',agentKey:'maker',reviewerKey:'reader',deliveryMode:'git',requiresAcceptance:true}],
    files:[],
  };
  if (prompt.startsWith('Prepare a studio agent')) return { summary:prompt.includes('QA-COACH-REJECT')?'QA-COACH-REJECT':'Учебный план.',
    selectedSkillIds:[], guide:prompt.includes('QA-COACH-EXERCISE')?'QA-COACH-EXERCISE':
      prompt.includes('QA-COACH-SPRINT')?'QA-COACH-SPRINT':'Проверьте документ.' };
  if (prompt.startsWith('Practice the studio assignment')) {
    if (prompt.includes('QA-COACH-EXERCISE') && prompt.includes('"bootstrap": true')) {
      const countFile = join(process.env.TMPDIR, 'qa-coach-exercise-count');
      const call = Number(readFileSync(countFile, { encoding: 'utf8', flag: 'a+' })) + 1;
      writeFileSync(countFile, String(call));
      if (call !== 4 || !prompt.includes('Your previous answer')) return { result:'QA: результат пришёл под другим ключом.' };
      return { summary:'QA: не допускать навык до проверки лицензии на указанном коммите.' };
    }
    return { summary:'Практика завершена.' };
  }
  if (prompt.startsWith('Review the studio agent') && prompt.includes('QA-COACH-EXERCISE') && prompt.includes('"bootstrap": true')) {
    if (!prompt.includes('QA: не допускать навык до проверки лицензии')) return { pass:false, summary:'QA: проверяющий не получил упражнение.' };
    return { pass:true, summary:'QA: директор проверил решение по лицензии.' };
  }
  if (prompt.startsWith('Review the studio agent') && prompt.includes('QA-COACH-SPRINT') && prompt.includes('"bootstrap": true')) {
    const countFile = join(process.env.TMPDIR, 'qa-coach-sprint-review-count');
    const call = Number(readFileSync(countFile, { encoding: 'utf8', flag: 'a+' })) + 1;
    writeFileSync(countFile, String(call));
    return { pass:call > 3, summary:call > 3 ? 'Директор принял упражнение.' : 'Уточните доказательства в упражнении.' };
  }
  if (prompt.includes('QA-CODEX-QUESTION')) {
    return prompt.includes('Подтверждаю QA T-17') ? { summary:'Codex: QA T-17 подтверждён.', artifact:'# QA ответ\n' }
      : { summary:'Codex: черновик.', question:{body:'Подтвердить QA T-17?',choices:[{label:'Подтвердить',answer:'Подтверждаю QA T-17'}]} };
  }
  if (prompt.startsWith('Work on') && prompt.includes('QA-WEB-HISTORICAL')) {
    return prompt.includes('"sourceResearch"') && prompt.includes(archiveSource)
      ? {summary:'Источники переданы исполнителю.',artifact:'# Сверка источников\n'}
      : {summary:'Публичный исторический источник не открылся.',question:{kind:'owner',body:'Не открывается исторический источник QA-WEB-HISTORICAL. Как продолжить?',choices:[]}};
  }
  if (prompt.startsWith('Review')) return prompt.includes('QA-COACH-REJECT')
    ? {pass:false,summary:'QA: приведите доказательство применимости навыка.'} : {pass:true, summary:'Независимая проверка пройдена.' };
  if (prompt.startsWith('Work on') && prompt.includes('QA-CHAPTER-FILE')) return { summary:'Глава готова.', artifact:'# Глава', artifactPath:'reports/chapter.md' };
  if (prompt.startsWith('Work on') && prompt.includes('QA-ART-FILE')) return { summary:'Описание готово.', artifact:'# Иллюстрация', artifactPath:'reports/art.md' };
  if (prompt.includes('QA-GIT-EDIT')) {
    if (!process.cwd().includes('/worktrees/')) throw Error('Fixture requires Hearth worktree: ' + process.cwd());
    const child = spawnSync('/usr/bin/sandbox-exec', [...fixtureSandbox(process.cwd()), '/bin/sh', '-c', 'printf "# QA deliverable\\n" > delivery.md']);
    if (child.status !== 0) throw Error('Fixture sandbox write failed: ' + (child.stderr || child.error || ''));
    return { summary:'QA файл доставлен.' };
  }
  if (prompt.startsWith('Reply to the owner')) {
    const context=JSON.parse(prompt.split('\n\n').at(-1));
    return {text:'QA ответ: '+context.recent[context.requestIndex].text,outcome:'answered'};
  }
  if (/decide the studio|director|retrospective/i.test(prompt.split('\n')[0])) return { action:'finish',summary:'QA завершено.' };
  return { summary:`${provider === 'claude' ? 'Claude' : 'Codex'}: проверочный текст готов.`, artifact:'# QA текст\n' };
}
if (args[0] === '--version') console.log(provider === 'claude' ? '2.1.326 (Claude Code)' : 'codex-cli 0.169.0');
else if (provider === 'claude' && args[0] === 'auth') send({ loggedIn:true });
else if (provider === 'claude' && args[0] === '--print') {
  let prompt = '';
  for await (const value of process.stdin) prompt += value;
  send({ type:'system', subtype:'init' });
  send({ type:'result', subtype:'success', session_id:threadId, result:JSON.stringify(response(prompt)), usage:{ input_tokens:20, output_tokens:10 } });
} else if (args[0] === 'mcp') console.log('No MCP servers configured yet.');
else if (args[0] === 'sandbox') {
  const dir = args[args.indexOf('-C') + 1];
  if (!dir?.includes('/worktrees/') || args.at(-1) !== '/usr/bin/true') process.exitCode = 2;
  else process.exitCode = spawnSync('/usr/bin/sandbox-exec', [...fixtureSandbox(dir), '/usr/bin/true']).status ?? 1;
}
else if (args[0] === 'app-server') {
  let pendingPlan;
  createInterface({ input:process.stdin, crlfDelay:Infinity }).on('line',line => {
    const {id,method,params={}} = JSON.parse(line);
    const reply = result => send({ id,result });
    if (method === 'initialize') reply({});
    if (method === 'account/read') reply({ account:{ type:'chatgpt' } });
    if (method === 'model/list') reply({ data:[{ model:'fixture',displayName:'Тестовая модель',supportedReasoningEfforts:[{ reasoningEffort:'low' }] }] });
    if (method === 'config/read') reply({config:{web_search:args.includes('web_search="disabled"')?'disabled':'live'}});
    if (method === 'modelProvider/capabilities/read') reply({webSearch:true});
    if (method === 'thread/start' || method === 'thread/resume') reply({
      thread:{ id:threadId,cwd:params.cwd,ephemeral:params.ephemeral === true },
      model:params.model || 'fixture',cwd:params.cwd,approvalPolicy:'never',activePermissionProfile:{ id:params.permissions },runtimeWorkspaceRoots:params.runtimeWorkspaceRoots,
    });
    if (method === 'turn/start') {
      const turnId = 'fixture-turn';
      const prompt = params.input[0].text;
      reply({ turn:{ id:turnId } });
      const finish = () => {
        const text = JSON.stringify(response(prompt));
        if (researchPrompt(prompt)) {
          if (params.permissions!=='hearth-studio-read-only' || !args.includes('web_search="live"')) throw new Error('The director needs read-only web access.');
          for (const action of [{type:'search',query:'Partition of India primary sources'},{type:'openPage',url:failedSource}]) {
            const results=action.type==='search' ? [{url:archiveSource}] : undefined;
            send({method:'item/completed',params:{threadId,turnId,item:{type:'webSearch',query:action.query ?? '',action,results}}});
          }
        }
        send({ method:'item/completed',params:{ threadId,turnId,item:{ type:'agentMessage',phase:'final_answer',text } } });
        send({ method:'turn/completed',params:{ threadId,turn:{ id:turnId,status:'completed' } } });
      };
      const hangingPid = join(process.env.TMPDIR, 'qa-queue-stop-pid');
      const cancelledTask = join(process.env.TMPDIR, 'qa-queue-cancelled');
      if (prompt.startsWith('Propose') && prompt.includes('QA-QUEUE-STOP') && !existsSync(hangingPid)) {
        writeFileSync(hangingPid, String(process.pid));
        pendingPlan = setTimeout(finish, 30_000);
      } else if (prompt.startsWith('Work on') && prompt.includes('QA-QUEUE-SPRINT') && prompt.includes('QA-CHAPTER-FILE') && !existsSync(cancelledTask)) {
        writeFileSync(cancelledTask, String(process.pid));
        pendingPlan = setTimeout(finish, 30_000);
      } else if (prompt.includes('QA-STOP-PLAN')) pendingPlan = setTimeout(finish,2500);
      else if (prompt.startsWith('Reply to the owner') && prompt.includes('QA-CONVERSATION-LIVE')) pendingPlan=setTimeout(finish,3500);
      else if (researchPrompt(prompt)) setTimeout(finish,700);
      else finish();
    }
    if (method === 'turn/interrupt') {
      clearTimeout(pendingPlan);
      reply({});
      setTimeout(() => send({ method:'turn/completed',params:{ threadId,
        turn:{ id:params.turnId,status:'interrupted' } } }),700);
    }
  });
} else {
  console.error('Unrecognized fake provider arguments:', args); process.exitCode = 1;
}
