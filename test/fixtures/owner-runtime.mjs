import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

const [provider, ...args] = process.argv.slice(2);
const threadId = 'c0b00000-1000-4000-a000-1000aaa00001';
const send = message => console.log(JSON.stringify(message));
const fixtureSandbox = cwd => ['-p', `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(cwd)}))`];
function response(prompt) {
  if(prompt.includes('QA-FORCED-ERROR')) throw new Error('QA intentional provider failure');
  if (prompt.startsWith('Propose')) return {
    title:'План QA', goal:'Проверить Git-доставку',
    epic:{ title:'Git-доставка',description:'Только фикстура.' }, story:{title:'Результат QA',acceptance:'Файл проверен.'},
    agents:[{key:'maker',role:'engineer',description:'Правит файлы'},{key:'reader',role:'other',description:'Проверяет изменения'}],
    tasks:[prompt.includes('QA-STOP-PLAN')
      ? {key:'first-text',title:'Первая глава',prompt:'Подготовить текст',criteria:'Черновик готов',agentKey:'maker',reviewerKey:'reader'}
      : {key:'git-file',title:'Git доставка QA',prompt:'QA-GIT-EDIT',criteria:'Файл проверен',agentKey:'maker',reviewerKey:'reader',deliveryMode:'git',requiresAcceptance:true}],
    files:[],
  };
  if (prompt.startsWith('Prepare a studio agent')) return { summary:prompt.includes('QA-COACH-REJECT')?'QA-COACH-REJECT':'Учебный план.', selectedSkillIds:[], guide:'Проверьте документ.' };
  if (prompt.startsWith('Practice the studio assignment')) return { summary:'Практика завершена.' };
  if (prompt.includes('QA-CODEX-QUESTION')) {
    return prompt.includes('Подтверждаю QA T-17') ? { summary:'Codex: QA T-17 подтверждён.', artifact:'# QA ответ\n' }
      : { summary:'Codex: черновик.', question:'Подтвердить QA T-17?' };
  }
  if (prompt.startsWith('Review')) return prompt.includes('QA-COACH-REJECT')
    ? {pass:false,summary:'QA: приведите доказательство применимости навыка.'} : {pass:true, summary:'Независимая проверка пройдена.' };
  if (prompt.includes('QA-GIT-EDIT')) {
    if (!process.cwd().includes('/worktrees/')) throw Error('Fixture requires Hearth worktree: ' + process.cwd());
    const child = spawnSync('/usr/bin/sandbox-exec', [...fixtureSandbox(process.cwd()), '/bin/sh', '-c', 'printf "# QA deliverable\\n" > delivery.md']);
    if (child.status !== 0) throw Error('Fixture sandbox write failed: ' + (child.stderr || child.error || ''));
    return { summary:'QA файл доставлен.' };
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
        send({ method:'item/completed',params:{ threadId,turnId,item:{ type:'agentMessage',phase:'final_answer',text } } });
        send({ method:'turn/completed',params:{ threadId,turn:{ id:turnId,status:'completed' } } });
      };
      if (prompt.includes('QA-STOP-PLAN')) pendingPlan = setTimeout(finish,2500);
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
