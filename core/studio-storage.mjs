import { lstatSync,mkdirSync,realpathSync,renameSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const absent=error=>error.code==='ENOENT';
function databasePath(directory,create=false) {
  const root=realpathSync(directory);
  let folder=root;
  for(const part of ['.hearth','state']) {
    folder=join(folder,part);
    if(create)mkdirSync(folder,{recursive:true,mode:0o700});
    if(!lstatSync(folder).isDirectory() || realpathSync(folder)!==folder)throw new Error('Путь к данным студии проходит через ссылку.');
  }
  const path=join(folder,'studio.sqlite3');
  const file=tryStat(path);
  if(file && (!file.isFile() || file.nlink!==1 || realpathSync(path)!==path))throw new Error('Данные студии должны быть обычным файлом.');
  return {root,path,exists:Boolean(file)};
}
function tryStat(path) {
  try {return lstatSync(path);} catch(error){if(!absent(error))throw error;}
}

export function createStudioStorage(profile,{initialize,collections}){
  profile.exec('CREATE TABLE IF NOT EXISTS studio_locations (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL)');
  const stored=new Map();
  const roots=new Map(profile.prepare('SELECT id,root FROM studio_locations').all().map(({id,root})=>[id,root]));
  const connection=path=>new DatabaseSync(path,{enableForeignKeyConstraints:true});
  for(const [id,root] of roots){
    try {
      const location=databasePath(root);
      if(location.exists)attach(id,location);
    } catch { /* Offline and damaged studios remain registered and are never resumed from old data. */ }
  }

  function attach(id,location){
    const db=connection(location.path);
    try {
      if(db.prepare('SELECT id FROM studios LIMIT 2').all().map(row=>row.id).join()!==id){
        throw new Error('Папка содержит данные другой студии.');
      }
      initialize(db);
      stored.set(id,{db,root:location.root});
      return db;
    } catch(error){db.close();throw error;}
  }
  function locate(table,id) {
    if(typeof id!=='string')return;
    for(const [studioId,{db,root}] of stored){
      const row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
      if(row)return {db,value:decode(table,row.data,root),studioId};
    }
    const row=profile.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if(!row)return;
    const value=JSON.parse(row.data);
    if(roots.has(table==='studios'?value.id:value.studioId))return;
    return {db:profile,value};
  }
  function decode(table,data,root){
    const value=JSON.parse(data);
    return table==='studios'?{...value,root,portable:true}:value;
  }
  function forStudio(id){return stored.get(id)?.db ?? profile;}
  function list(table) {
    const records=profile.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row=>JSON.parse(row.data))
      .filter(row=>!roots.has(table==='studios'?row.id:row.studioId));
    for(const {db,root} of stored.values()){
      records.push(...db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row=>decode(table,row.data,root)));
    }
    return records;
  }
  function remember(id,root,db){
    profile.prepare('INSERT INTO studio_locations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root').run(id,root);
    roots.set(id,root);
    stored.set(id,{root,db});
  }

  function migrate(id,directory){
    if(roots.has(id)){
      const current=stored.get(id);
      if(!current || current.root!==realpathSync(directory))throw new Error('Студия подключена к другой папке.');
      return;
    }
    const studio=profile.prepare('SELECT data FROM studios WHERE id=?').get(id);
    if(!studio)throw new Error('Студия не найдена.');
    const location=databasePath(directory,true);
    if(location.exists){
      const db=attach(id,location);
      remember(id,location.root,db);
      return;
    }
    const temp=location.path+'.'+randomUUID()+'.migrating';
    const target=connection(temp);
    try {
      initialize(target);
      target.exec('BEGIN IMMEDIATE');
      const value=JSON.parse(studio.data);
      target.prepare('INSERT INTO studios VALUES (?,?)').run(id,JSON.stringify({...value,root:'.',portable:true}));
      for(const table of ['tasks','inbox','task_transitions','task_transition_sources',...collections]){
        const scope=table==='task_transition_sources'?'seq IN (SELECT seq FROM task_transitions WHERE studio_id=?)':
          table==='inbox'?'task_id IN (SELECT id FROM tasks WHERE studio_id=?)':
          ['tasks','task_transitions'].includes(table)?'studio_id=?':"json_extract(data,'$.studioId')=?";
        const rows=profile.prepare(`SELECT * FROM ${table} WHERE ${scope} ORDER BY rowid`).all(id);
        for (const row of rows){
          const columns=Object.keys(row);
          target.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
        }
      }
      target.exec('COMMIT');
      if(target.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Копия данных студии не прошла проверку SQLite.');
      target.close();
      if(tryStat(location.path))throw new Error('В папке уже есть другая база студии.');
      renameSync(temp,location.path);
      const db=attach(id,location);
      remember(id,location.root,db);
    } finally {
      if(target.isOpen)target.close();
      rmSync(temp,{force:true});
    }
  }

  function open(id,directory,{replaceRoot=false}={}){
    const location=databasePath(directory);
    if(!location.exists)throw new Error('В папке нет данных студии.');
    const previous=stored.get(id);
    const sameRoot=roots.get(id)===location.root;
    if(roots.has(id) && !sameRoot && !replaceRoot)throw new Error('Студия уже открыта из другой папки.');
    const legacy=profile.prepare('SELECT id FROM studios WHERE id=?').get(id);
    if(legacy && !roots.has(id))throw new Error('Эта студия уже открыта в прежнем хранилище.');
    if(previous && sameRoot)return false;
    const db=attach(id,location);
    try {
      if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('База студии не прошла проверку.');
      const row=db.prepare('SELECT data FROM studios WHERE id=?').get(id);
      const studio=decode('studios',row.data,location.root);
      const paused={...studio,root:'.',manualPaused:true,copyPrepared:true};
      db.prepare('UPDATE studios SET data=? WHERE id=?').run(JSON.stringify(paused),id);
      remember(id,location.root,db);
      previous?.db.close();
      return true;
    } catch(error){
      if(previous)stored.set(id,previous);
      else stored.delete(id);
      db.close();
      throw error;
    }
  }
  function disconnect(id){
    const entry=stored.get(id);
    if(entry){
      entry.db.close();stored.delete(id);
      // Keep the legacy backup hidden after deleting a migrated record.
      profile.prepare('DELETE FROM studios WHERE id=?').run(id);
    }
    profile.prepare('DELETE FROM studio_locations WHERE id=?').run(id);
    roots.delete(id);
  }
  return {forStudio,locate,list,open,migrate,disconnect,databases:()=>[profile,...[...stored.values()].map(entry=>entry.db)]};
}
