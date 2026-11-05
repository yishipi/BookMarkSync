import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchBrowser } from './cdp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = path.join(root, 'work');
let run;
for (const name of (await readdir(work)).filter(name => name.startsWith('browser-')).sort().reverse()) {
  try { if (JSON.parse(await readFile(path.join(work, name, 'result.json'), 'utf8')).passed) { run = path.join(work, name); break; } }
  catch { /* Incomplete runs are not fixtures. */ }
}
assert.ok(run, '请先运行 npm run test:browser。');
assert.ok(path.resolve(run).startsWith(path.resolve(work) + path.sep), '只能修改独立测试配置');
const preferencesPath = path.join(run, 'Chrome/Default/Preferences');
const report = { startedAt: new Date().toISOString(), run, checks: [],
  permissionMethod: 'Revoke and restore chooser grants only in the isolated test profile. Native permission dialogs are not automated.' };
const checked = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, edge, savedPermissions;

async function command(browser, type, fields = {}) {
  const response = await browser.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...fields })})`);
  assert.equal(response.ok, true, response.error);
  return response.result;
}

async function waitFor(check, description) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await pause(200); }
  throw new Error(`Timeout: ${description}`);
}

async function restoreGrant() {
  if (!savedPermissions) return;
  const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
  Object.assign(preferences.profile.content_settings.exceptions, savedPermissions);
  await writeFile(preferencesPath, JSON.stringify(preferences));
  savedPermissions = null;
}

try {
  chrome = await launchBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(run, 'Chrome'), path.join(root, 'extension'));
  edge = await launchBrowser('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', path.join(run, 'Edge'), path.join(root, 'extension'));
  await command(chrome, 'pause');
  const url = `https://permission-pending.example/${Date.now()}`;
  await edge.evaluate(`chrome.bookmarks.create({parentId:'1',title:'授权恢复后待接收',url:${JSON.stringify(url)}})`);
  assert.equal((await command(edge, 'sync')).status.phase, 'ready');
  assert.equal((await chrome.evaluate(`chrome.bookmarks.search({url:${JSON.stringify(url)}})`)).length, 0);
  const before = await chrome.evaluate(`(async()=> (await chrome.bookmarks.getTree())[0].children)()`);
  await chrome.close();

  const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
  const exceptions = preferences.profile.content_settings.exceptions;
  savedPermissions = Object.fromEntries(Object.entries(exceptions).filter(([key]) => key.startsWith('file_system_access')));
  assert.ok(Object.keys(savedPermissions).length);
  for (const key of Object.keys(savedPermissions)) delete exceptions[key];
  await writeFile(preferencesPath, JSON.stringify(preferences));
  chrome = await launchBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(run, 'Chrome'), path.join(root, 'extension'));
  const permission = await chrome.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');return (await database.get('directory')).queryPermission({mode:'readwrite'})})()`);
  assert.notEqual(permission, 'granted', '必须真正撤销授权');
  assert.equal((await command(chrome, 'sync')).status.phase, 'permission');
  assert.equal(await chrome.evaluate('chrome.action.getBadgeText({})'), '授权');
  assert.deepEqual(await chrome.evaluate(`(async()=> (await chrome.bookmarks.getTree())[0].children)()`), before);
  await waitFor(() => chrome.evaluate(`!document.getElementById('grant').hidden`), 'permission recovery button');
  const screenshot = await chrome.client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, chrome.sessionId);
  await writeFile(path.join(run, 'Chrome-permission.png'), Buffer.from(screenshot.data, 'base64'));
  checked('真实目录授权撤销后：保留书签、显示授权徽标和恢复按钮，无后台授权弹窗');

  await chrome.close();
  await restoreGrant();
  chrome = await launchBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(run, 'Chrome'), path.join(root, 'extension'));
  await waitFor(() => chrome.evaluate(`!document.getElementById('grant').hidden && !document.getElementById('grant').disabled`), 'grant button ready');
  await chrome.evaluate(`document.getElementById('grant').click()`);
  await waitFor(async () => (await command(chrome, 'status')).status.phase === 'preview', 'paused permission recovery preview');
  assert.equal((await command(chrome, 'status')).config.enabled, false);
  assert.equal((await chrome.evaluate(`chrome.bookmarks.search({url:${JSON.stringify(url)}})`)).length, 0);
  await waitFor(() => chrome.evaluate(`!document.getElementById('sync').hidden && !document.getElementById('sync').disabled`), 'manual sync available after recovery');
  checked('实际设置页恢复授权只显示预览，保留暂停，尚未导入对端变化');
  await chrome.evaluate(`document.getElementById('sync').click()`);
  await waitFor(async () => (await chrome.evaluate(`chrome.bookmarks.search({url:${JSON.stringify(url)}})`)).length === 1, 'explicit manual sync');
  await waitFor(async () => (await command(chrome, 'status')).status.phase === 'paused', 'remain paused after manual sync');
  assert.equal(await chrome.evaluate(`chrome.alarms.get('periodic-sync')`), undefined);
  await waitFor(() => chrome.evaluate(`!document.getElementById('enable').disabled`), 'resume button ready');
  await chrome.evaluate(`document.getElementById('enable').click()`);
  await waitFor(async () => (await command(chrome, 'status')).status.phase === 'ready', 'resume automatic sync');
  checked('实际设置页手动同步只执行一次；恢复自动同步后才重建周期任务');

  await chrome.evaluate(`(async()=>{
    const {database,DirectoryExchange}=await import('./lib/storage.js');
    const original=await database.get('directory');
    const invalid=await original.getDirectoryHandle('invalid-selection',{create:true});
    const exchange=new DirectoryExchange(invalid);
    await exchange.workspace({create:true});
    await exchange.write('replica-invalid-file.json',{schema:99});
  })()`);
  // Acquire the selected directory as a chooser root, just like production.
  // Child handles derived from the pre-seeded test grant can deserialize as
  // that grant's root in Chromium; they are not a valid chooser fixture.
  await chrome.evaluate(`
    document.addEventListener('dragover',event=>event.preventDefault());
    document.addEventListener('drop',event=>{event.preventDefault();
      window.invalidSelection=event.dataTransfer.items[0].getAsFileSystemHandle().then(async handle=>{
        const {database}=await import('./lib/storage.js');
        const directoryKey='selection:'+crypto.randomUUID();await database.set(directoryKey,handle);return directoryKey;
      });
    }); true`);
  const drag = { items: [], files: [path.join(run, 'shared/invalid-selection').replaceAll('\\', '/')], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await chrome.client.send('Input.dispatchDragEvent', { type, x: 200, y: 200, data: drag }, chrome.sessionId);
  const directoryKey = await chrome.evaluate('window.invalidSelection');
  const selectionResult = await chrome.evaluate(`(async()=>{
    const {database,DirectoryExchange}=await import('./lib/storage.js');
    const original=await database.get('directory');const directoryKey=${JSON.stringify(directoryKey)};
    const selected=await database.get(directoryKey);
    const documents=await new DirectoryExchange(selected).documents();
    try {
      const response=await chrome.runtime.sendMessage({type:'configure',settings:{directoryKey,label:'不应保存'}});
      return {documents:documents.map(item=>item.document.schema),ok:response.ok,error:response.error,same:await original.isSameEntry(await database.get('directory'))};
    } finally { await database.remove(directoryKey); }
  })()`);
  assert.deepEqual(selectionResult.documents, [99], '存入并读取的选择句柄必须确实指向无效目录');
  assert.equal(selectionResult.ok, false);
  assert.equal(selectionResult.same, true);
  assert.equal((await command(chrome, 'status')).config.enabled, true);
  assert.notEqual((await command(chrome, 'status')).config.label, '不应保存');
  checked('真实目录句柄和 IndexedDB：新目录校验失败不替换原连接及设置');

  const atomic = await chrome.evaluate(`(async()=>{
    const {database}=await import('./lib/storage.js');
    await database.set('atomic-check','before');
    let rejected=false;
    try { await database.setMany([['atomic-check','after'],['atomic-invalid',()=>{}]]); }
    catch { rejected=true; }
    return {rejected,value:await database.get('atomic-check')};
  })()`);
  assert.equal(atomic.rejected, true);
  assert.equal(atomic.value, 'before', '同步抛出的克隆错误也必须中止整个事务');
  checked('真实 IndexedDB：后续写入同步失败时，之前的写入也完整回滚');

  const marker = await chrome.evaluate(`(async()=>{
    const {database,DirectoryExchange}=await import('./lib/storage.js');
    const handle=await database.get('directory');
    const marker=await new DirectoryExchange(handle).workspace();
    await handle.removeEntry('BookMarkSync.workspace.json');
    return marker;
  })()`);
  await writeFile(path.join(run, 'workspace-marker-backup.json'), JSON.stringify(marker));
  const tree = await chrome.evaluate('chrome.bookmarks.getTree()');
  assert.equal((await command(chrome, 'sync')).status.phase, 'error');
  assert.deepEqual(await chrome.evaluate('chrome.bookmarks.getTree()'), tree);
  assert.equal(await chrome.evaluate('chrome.action.getBadgeText({})'), '!');
  assert.equal(await chrome.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');try{await (await database.get('directory')).getFileHandle('BookMarkSync.workspace.json');return true;}catch(error){if(error.name==='NotFoundError')return false;throw error;}})()`), false);
  await chrome.evaluate(`(async()=>{const {database,DirectoryExchange}=await import('./lib/storage.js');await new DirectoryExchange(await database.get('directory')).write('BookMarkSync.workspace.json',${JSON.stringify(marker)})})()`);
  assert.equal((await command(chrome, 'sync')).status.phase, 'ready');
  checked('真实工作区标识丢失时停止应用且显示错误，恢复原文件后继续');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; throw error;
} finally {
  if (chrome) await chrome.close();
  if (edge) await edge.close();
  await restoreGrant();
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(run, 'permissions-result.json'), JSON.stringify(report, null, 2));
  console.log(`权限与提示验证记录：${run}`);
}
