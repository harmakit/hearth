import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogue} from '../renderer/copy-catalog.mjs';
import {copy,setCopyLocale} from '../renderer/copy.mjs';
import {renderWork} from '../renderer/work-view.mjs';
import {renderWorkspaceHome} from '../renderer/workspace-view.mjs';
import {localeNames,tokenCount} from '../renderer/locale.mjs';
test('all locale catalog entries contain four usable translations; literal user input stays untouched',()=>{
  for(const [key,row] of Object.entries(catalogue)) {
    assert.equal(row.length,4,key);
    for(const v of row) assert.ok(v.trim() && !v.includes('▁'),key);
  }
  for(const locale of Object.keys(localeNames)){
    setCopyLocale(locale);
    const input='Отмена';
    assert.equal(copy`${input}`,input);
    const page=renderWork({tab:'registry',tasks:[{id:'qa',title:input}]});
    assert.ok(page.includes('<strong>Отмена</strong>'));
    const home=renderWorkspaceHome({appLocale:locale,studios:[{id:'s',name:input}]});
    assert.ok(home.includes('>Отмена</button>'));
    if(locale!=='ru')assert.notEqual(copy('Остановить'),'Остановить');
  }
  setCopyLocale('en');
  assert.match(copy('» будут удалены из Hearth. Папка проекта и её файлы сохранятся.'),/files will be preserved/);
  setCopyLocale('ru');
  assert.equal(tokenCount('ru',1),'1 токен');
  assert.equal(tokenCount('ru',3),'3 токена');
  assert.equal(tokenCount('ru',12),'12 токенов');
});
