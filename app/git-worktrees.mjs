import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const idPattern = /^[0-9a-f]{64}$/;
const taskBranchPrefix = 'refs/heads/hearth/';
export const minimumGitVersion = '2.43.0';
const minimumPortableGit = '2.48.0';
const gitConfig = [
  ...(process.platform === 'win32' ? ['core.longpaths=true'] : []),
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.attributesFile=/dev/null',
  'maintenance.auto=false',
  'gc.auto=0',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'submodule.recurse=false',
  'protocol.allow=never',
];

function runGit(repository, args, options = {}, config = []) {
  const {
    input, encoding = 'utf8', maxBuffer = 16 * 1024 * 1024,
    timeout = 30_000, signal, allowExitCodes = [],
  } = options;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: '',
    LC_ALL: 'C',
  });
  const flags = [...gitConfig, ...config].flatMap(value => ['-c', value]);
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '-C', repository, ...flags, ...args], {
      env, encoding, maxBuffer, timeout, signal, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error || allowExitCodes.includes(error.code)) {
        resolve(stdout);
      } else {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input);
  });
}

export function verifyGitVersion(output) {
  const version = /^git version (\d+\.\d+\.\d+)(?:\.|\s|$)/u.exec(output)?.[1];
  const order = version?.localeCompare(minimumGitVersion, 'en', { numeric:true });
  if (order === undefined || order < 0) {
    throw Object.assign(new Error(`Для рабочих копий и доставки нужен Git ${minimumGitVersion} или новее. ` +
      (version ? `Обнаружен Git ${version}.` : 'Версию Git определить не удалось.')), {code:'GIT_VERSION_UNSUPPORTED'});
  }
  return version;
}

export async function requireProjectGit(directory) {
  let output;
  try { output = await runGit(directory, ['--version']); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Установите Git ${minimumGitVersion} или новее и добавьте его в PATH.`, {cause:error});
  }
  return verifyGitVersion(output);
}

export async function git(repository, args, options) {
  const keys = await runGit(repository, [
    'config', '--null', '--name-only', '--get-regexp',
    '^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$',
  ], { signal: options?.signal, allowExitCodes: [1] });
  const config = [...new Set(keys.split('\0').filter(Boolean))].map(key => {
    if (key.startsWith('merge.')) return `${key}=/usr/bin/false`;
    return key.endsWith('.required') ? `${key}=false` : `${key}=`;
  });
  return runGit(repository, args, options, config);
}

function recordId(studioId, taskId) {
  return createHash('sha256').update(JSON.stringify([studioId, taskId])).digest('hex');
}

function taskIdentity(studioId, taskId) {
  if (![studioId, taskId].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Worktree requires a studio and task identifier');
  }
  return recordId(studioId, taskId);
}

function gitLine(output) {
  return output.replace(process.platform === 'win32' ? /\r?\n$/u : /\n$/u, '');
}

export const nativeGitPath = (path, platform = process.platform) => platform === 'win32' ? win32.normalize(path) : path;

async function registeredEntry(repository, path) {
  const entries = (await git(repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  return entries.map(item => item.split('\0')).find(([entry]) =>
    entry.startsWith('worktree ') && nativeGitPath(entry.slice(9)) === path);
}

async function pathStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function hasProjectGitDirectory(root) {
  return Boolean((await pathStat(join(root, '.git')))?.isDirectory());
}

async function verifiedDirectory(path) {
  if (!(await pathStat(path))?.isDirectory() || await realpath(path) !== path) {
    throw new Error(`Invalid worktree directory: ${path}`);
  }
  return path;
}

async function oid(repository, ref) {
  const result = (await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!oidPattern.test(result)) throw new Error('Git did not resolve a commit');
  return result;
}

async function refOid(repository, ref) {
  return (await git(repository, [
    'rev-parse', '--verify', '--quiet', '--end-of-options', ref,
  ], { allowExitCodes: [1] })).trim();
}

async function requireDirectRef(repository, ref) {
  const symbolic = await git(repository, ['symbolic-ref', '-q', ref], { allowExitCodes: [1] });
  if (symbolic) throw new Error('Git branch must be a direct ref');
}

async function localBranch(repository, targetRef) {
  if (typeof targetRef !== 'string' || !targetRef || targetRef.startsWith('-') ||
      (targetRef.startsWith('refs/') && !targetRef.startsWith('refs/heads/'))) {
    throw new Error('Target must be a local Git branch');
  }
  const ref = targetRef.startsWith('refs/heads/') ? targetRef : `refs/heads/${targetRef}`;
  await git(repository, ['check-ref-format', ref]);
  if (ref.startsWith(taskBranchPrefix)) throw new Error('Target must be a direct local Git branch');
  await requireDirectRef(repository, ref);
  return ref;
}

export function createGitWorktrees({ storageDir, projectRoot, validateRepository } = {}) {
  if(projectRoot)storageDir=join(projectRoot,'.hearth');
  if (typeof storageDir !== 'string' || !isAbsolute(storageDir) || typeof validateRepository !== 'function') {
    throw new Error('Worktrees require an absolute storage directory and repository validator');
  }
  const requests = new Map();
  let storage;

  async function storagePaths() {
    storage ??= (async () => {
      await mkdir(storageDir, { recursive: true, mode: 0o700 });
      const root = await realpath(storageDir);
      if(projectRoot && root!==storageDir)throw new Error('Каталог рабочих копий Hearth находится за пределами проекта.');
      return {
        root,
        registry: projectRoot?join(root,'state','worktree-registry'):join(root,'worktree-registry'),
        worktrees: join(root, 'worktrees'),
      };
    })().catch(error => {
      storage = undefined;
      throw error;
    });
    const paths = await storage;
    await verifiedDirectory(paths.root);
    for (const path of [paths.registry, paths.worktrees]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await verifiedDirectory(path);
    }
    return paths;
  }

  async function repositoryIdentity(repository) {
    if (typeof repository !== 'string' || !isAbsolute(repository)) {
      throw new Error('Repository must be an absolute Git project directory');
    }
    const canonical = await realpath(repository);
    const approved = await validateRepository(canonical);
    if (approved === false || (typeof approved === 'string' && await realpath(approved) !== canonical)) {
      throw new Error('Repository is outside the approved project directory');
    }
    const metadata = join(canonical, '.git');
    const marker = await pathStat(metadata);
    if (!marker) throw new Error('В выбранной папке нет Git-репозитория.');
    if (!marker.isDirectory()) throw new Error('Выберите основную папку Git-репозитория.');
    const version=await requireProjectGit(canonical);
    if(projectRoot && version.localeCompare(minimumPortableGit,'en',{numeric:true})<0)
      throw new Error(`Для переносимых рабочих копий нужен Git ${minimumPortableGit} или новее.`);
    const gitCommonDir = await verifiedDirectory(metadata);
    if(projectRoot && await pathStat(join(gitCommonDir,'objects','info','alternates'))) {
      throw new Error('Git-объекты находятся за пределами проекта. Сначала подготовьте самостоятельный репозиторий.');
    }
    const topLevel = gitLine(await git(canonical, ['rev-parse', '--show-toplevel']));
    const discoveredCommon = gitLine(await git(canonical, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    if (await realpath(topLevel) !== canonical || await realpath(discoveredCommon) !== gitCommonDir) {
      throw new Error('Repository does not identify its own Git working directory');
    }
    return { repository: canonical, gitCommonDir };
  }

  async function prepareTarget({ repository, targetRef, baseRef, create = false }) {
    const identity = await repositoryIdentity(repository);
    const ref = await localBranch(identity.repository, targetRef);
    const existing = await refOid(identity.repository, ref);
    if (!existing && create === true) {
      const baseOid = await oid(identity.repository, baseRef ?? 'HEAD');
      try {
        await git(identity.repository, ['update-ref', '--no-deref', ref, baseOid, '0'.repeat(baseOid.length)]);
      } catch (error) {
        if (await refOid(identity.repository,ref) !== baseOid) throw error;
      }
      return { ...identity, targetRef: ref, targetOid: baseOid, baseOid };
    }
    const targetOid = await oid(identity.repository, ref);
    const baseOid = baseRef === undefined ? targetOid : await oid(identity.repository, baseRef);
    return { ...identity, targetRef: ref, targetOid, baseOid };
  }

  async function readRecord(id, paths) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid worktree ID');
    const file = join(paths.registry, `${id}.json`);
    const stat = await pathStat(file);
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid worktree registration file');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const record = projectRoot && saved.layout==='project' && saved.path===`worktrees/${id}` && saved.repository==='.' && saved.gitCommonDir==='.git'
      ? {...saved,path:join(paths.worktrees,id),repository:projectRoot,gitCommonDir:join(projectRoot,'.git')}
      : saved;
    if(projectRoot && (saved.layout!=='project' || saved.path!==`worktrees/${id}` || saved.repository!=='.' || saved.gitCommonDir!=='.git')){
      throw new Error('Рабочая копия не зарегистрирована внутри проекта.');
    }
    if (record.id !== id || taskIdentity(record.studioId, record.taskId) !== id ||
        record.path !== join(paths.worktrees, id) || record.branchRef !== `${taskBranchPrefix}${id}` ||
        typeof record.repository !== 'string' || !isAbsolute(record.repository) ||
        record.gitCommonDir !== join(record.repository, '.git') ||
        typeof record.targetRef !== 'string' || !record.targetRef.startsWith('refs/heads/') ||
        !oidPattern.test(record.baseOid) || !['pending', 'ready', 'cleaned'].includes(record.status) ||
        (record.status === 'cleaned' && typeof record.cleanedAt !== 'string')) {
      throw new Error('Invalid worktree registration');
    }
    return record;
  }

  async function writeRecord(record, paths, replace) {
    const file = join(paths.registry, `${record.id}.json`);
    const temporary = join(paths.registry, `${record.id}.${randomUUID()}.tmp`);
    const saved=projectRoot?{...record,layout:'project',path:'worktrees/'+record.id,repository:'.',gitCommonDir:'.git'}:record;
    await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600, flush: true });
    try {
      if (replace) await rename(temporary, file);
      else await link(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function verifyWorktree(record) {
    await verifiedDirectory(record.path);
    const identity = await repositoryIdentity(record.repository);
    await requireDirectRef(identity.repository, record.branchRef);
    const entry = await registeredEntry(identity.repository, record.path);
    const pointerPath = join(record.path, '.git');
    const dotGit = await pathStat(pointerPath);
    if (identity.gitCommonDir !== record.gitCommonDir ||
        !entry?.includes(`branch ${record.branchRef}`) ||
        !dotGit?.isFile() || dotGit.nlink !== 1 || dotGit.size > 8192) {
      throw new Error('Git worktree does not match its registration');
    }
    const pointer = gitLine(await readFile(pointerPath, 'utf8'));
    const gitDir = resolve(record.path, pointer.slice('gitdir: '.length));
    if (!pointer.startsWith('gitdir: ') || dirname(gitDir) !== join(record.gitCommonDir, 'worktrees')) {
      throw new Error('Git worktree points outside its repository metadata');
    }
    await verifiedDirectory(gitDir);
    const backlink = gitLine(await readFile(join(gitDir, 'gitdir'), 'utf8'));
    if (resolve(gitDir, backlink) !== pointerPath) {
      throw new Error('Git worktree metadata does not reference its registered path');
    }
    const common = gitLine(await git(record.path, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    const branch = (await git(record.path, ['symbolic-ref', 'HEAD'])).trimEnd();
    const top = gitLine(await git(record.path, ['rev-parse', '--show-toplevel']));
    if (await realpath(common) !== record.gitCommonDir || await realpath(top) !== record.path ||
        branch !== record.branchRef) {
      throw new Error('Git worktree does not match its registration');
    }
    return record;
  }

  async function getWorktree(id, verify = true) {
    const record = await readRecord(id, await storagePaths());
    if (record && verify) {
      if (record.status !== 'ready') throw new Error(`Worktree registration is ${record.status}`);
      await verifyWorktree(record);
    }
    return record;
  }

  async function listWorktrees({ studioId }) {
    const paths = await storagePaths();
    const files = await readdir(paths.registry);
    const ids = files.filter(file => idPattern.test(file.slice(0, -5)) && file.endsWith('.json'));
    const records = await Promise.all(ids.map(file => readRecord(file.slice(0, -5), paths)));
    return records.filter(record => record?.studioId === studioId);
  }

  async function ensure(request, id) {
    const paths = await storagePaths();
    const identity = await repositoryIdentity(request.repository);
    const targetRef = await localBranch(identity.repository, request.targetRef);
    let record = await readRecord(id, paths);
    if (!record) {
      const path = join(paths.worktrees, id);
      const branchRef = `${taskBranchPrefix}${id}`;
      await requireDirectRef(identity.repository, branchRef);
      if (await pathStat(path) || await refOid(identity.repository, branchRef)) {
        throw new Error('Worktree path or branch already exists without a registration');
      }
      const baseOid = await oid(identity.repository, targetRef);
      record = {
        id, path, branchRef,...(projectRoot?{layout:'project'}:{}),
        targetRef, baseOid, studioId: request.studioId, taskId: request.taskId,
        ...identity, status: 'pending',
      };
      await writeRecord(record, paths, false);
    }
    if (record.repository !== identity.repository || record.gitCommonDir !== identity.gitCommonDir ||
        record.targetRef !== targetRef) {
      throw new Error('Task already has a worktree registered with another repository or target branch');
    }
    if (record.status === 'ready') return verifyWorktree(record);
    if (record.status === 'cleaned') throw new Error('Task worktree has already been cleaned');

    const mark = `hearth-worktree:${id}`;
    await requireDirectRef(record.repository, record.branchRef);
    const branchOid = await refOid(record.repository, record.branchRef);
    const checkoutExists = Boolean(await pathStat(record.path));
    if (branchOid) {
      const origin = (await git(record.repository, [
        'reflog', 'show', '-1', '--format=%gs', record.branchRef,
      ])).trim();
      if (branchOid !== record.baseOid || origin !== mark) {
        throw new Error('Pending worktree branch does not match its registration');
      }
    } else if (checkoutExists) {
      throw new Error('Pending worktree path exists without its registered branch');
    } else {
      await git(record.repository, [
        '-c', 'user.name=Hearth Studio', '-c', 'user.email=hearth-studio@localhost',
        'update-ref', '--no-deref', '--create-reflog', '-m', mark,
        record.branchRef, record.baseOid, '0'.repeat(record.baseOid.length),
      ]);
    }
    if (!checkoutExists) {
      const adminDir = join(record.gitCommonDir, 'worktrees');
      if (await pathStat(adminDir)) await verifiedDirectory(adminDir);
      await git(record.repository, [
        'worktree', 'add', '--no-guess-remote', ...(projectRoot?['--relative-paths']:[]),
        '--', record.path, record.branchRef.slice('refs/heads/'.length),
      ]);
    }
    await verifyWorktree(record);
    if (await oid(record.path, 'HEAD') !== record.baseOid) {
      throw new Error('Pending worktree does not match its registered base');
    }
    const ready = { ...record, status: 'ready' };
    await writeRecord(ready, paths, true);
    return ready;
  }

  async function serialize(id, operation) {
    const previous = requests.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    requests.set(id, next);
    try {
      return await next;
    } finally {
      if (requests.get(id) === next) requests.delete(id);
    }
  }

  async function ensureWorktree(request) {
    const id = taskIdentity(request.studioId, request.taskId);
    return serialize(id, () => ensure(request, id));
  }

  async function markCleaned(id) {
    return serialize(id, async () => {
      const paths = await storagePaths();
      const record = await readRecord(id, paths);
      if (record?.status === 'cleaned') return record;
      if (record?.status !== 'ready') throw new Error('Worktree registration is not ready');
      await repositoryIdentity(record.repository);
      if (await pathStat(record.path) || await registeredEntry(record.repository, record.path)) {
        throw new Error('Managed worktree is still present');
      }
      const cleaned = { ...record, status: 'cleaned', cleanedAt: new Date().toISOString() };
      await writeRecord(cleaned, paths, true);
      return cleaned;
    });
  }

  async function moveFrom(record){
    if(!projectRoot || record.repository!==projectRoot)throw new Error('Рабочая копия относится к другому проекту.');
    return serialize(record.id,async()=>{
      const paths=await storagePaths();
      const destination=join(paths.worktrees,record.id);
      const previous=await readRecord(record.id,paths);
      if(previous)return previous.status==='ready'?verifyWorktree(previous):previous;
      const next={...record,path:destination,layout:'project'};
      if(record.status==='pending')throw new Error('Сначала восстановите незавершённое создание рабочей копии.');
      if(record.status==='ready'){
        if(await pathStat(record.path)){
          if(await pathStat(destination))throw new Error('Папка для рабочей копии уже занята.');
          await verifyWorktree(record);
          await git(record.repository,['worktree','move','--',record.path,destination]);
        }
        await verifyWorktree(next);
        await git(projectRoot,['worktree','repair','--relative-paths','--',destination]);
        await verifyWorktree(next);
      }
      await writeRecord(next,paths,false);
      return next;
    });
  }

  return { ensureWorktree, getWorktree, listWorktrees, prepareTarget, markCleaned,moveFrom };
}

export function createProjectWorktrees({legacy,validateRepository,studios}) {
  const projects=new Map();
  const forProject=root=>{
    if(!projects.has(root))projects.set(root,createGitWorktrees({projectRoot:root,validateRepository}));
    return projects.get(root);
  };
  async function locate(id,verify,studioId){
    const studio=studios().find(row=>row.id===studioId);
    if(!studio || studio.projectDetached)throw new Error('Рабочая копия не относится к открытой студии.');
    const trees=studio.portable?forProject(studio.root):legacy;
    const found=await trees.getWorktree(id,verify);
    const entry=found?.studioId===studioId && found.repository===studio.root?found:undefined;
    return {trees,entry};
  }
  return {
    ensureWorktree(request){
      const studio=studios().find(row=>row.id===request.studioId && row.root===request.repository);
      return (studio?.portable?forProject(studio.root):legacy).ensureWorktree(request);
    },
    listWorktrees({studioId}){
      const studio=studios().find(row=>row.id===studioId);
      return (studio?.portable && studio.projectGit?.enabled?forProject(studio.root):legacy).listWorktrees({studioId});
    },
    async getWorktree(id,verify=true,studioId){return (await locate(id,verify,studioId)).entry;},
    async markCleaned(id,studioId){
      const {trees,entry}=await locate(id,false,studioId);
      if(!entry)throw new Error('Рабочая копия отсутствует в выбранной папке студии.');
      return trees.markCleaned(id);
    },
    prepareTarget:legacy.prepareTarget,
    async migrate(studio){
      for(const record of await legacy.listWorktrees({studioId:studio.id}))await forProject(studio.root).moveFrom(record);
    },
  };
}
