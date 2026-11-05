import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser } from './cdp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = path.join(root, 'work');
let run;
for (const name of (await readdir(work)).filter(name => name.startsWith('browser-')).sort().reverse()) {
  try { if (JSON.parse(await readFile(path.join(work, name, 'result.json'), 'utf8')).passed) { run = path.join(work, name); break; } }
  catch { /* Ignore incomplete fixtures. */ }
}
assert.ok(run, '请先运行 npm run test:browser。');
const browsers = [];
const report = { startedAt: new Date().toISOString(), run, checks: [] };
const stamp = String(Date.now());
const title = suffix => `文件夹验证-${stamp}-${suffix}`;
async function command(browser, type) {
  const response = await browser.evaluate(`chrome.runtime.sendMessage({type:${JSON.stringify(type)}})`);
  assert.equal(response.ok, true, response.error);
  assert.notEqual(response.result.status.phase, 'error', response.result.status.message);
  return response.result;
}
const checked = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  const chrome = await launchBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(run, 'Chrome'), path.join(root, 'extension'));
  browsers.push(chrome);
  const edge = await launchBrowser('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', path.join(run, 'Edge'), path.join(root, 'extension'));
  browsers.push(edge);
  const ids = await chrome.evaluate(`(async()=>{
    const a=await chrome.bookmarks.create({parentId:'1',title:${JSON.stringify(title('A'))}});
    const b=await chrome.bookmarks.create({parentId:a.id,title:${JSON.stringify(title('B'))}});
    const c=await chrome.bookmarks.create({parentId:b.id,title:${JSON.stringify(title('C'))}});
    await chrome.bookmarks.create({parentId:c.id,title:'嵌套内容',url:'https://folder-cycle.example/${stamp}'});
    return {a:a.id,b:b.id,c:c.id};})()`);
  await command(chrome, 'sync'); await command(edge, 'sync');
  assert.equal((await edge.evaluate(`chrome.bookmarks.search({url:'https://folder-cycle.example/${stamp}'})`)).length, 1);
  checked('真实浏览器创建并同步多层文件夹');
  await chrome.evaluate(`(async()=>{await chrome.bookmarks.move('${ids.c}',{parentId:'1'});await chrome.bookmarks.move('${ids.a}',{parentId:'${ids.c}'});})()`);
  await command(chrome, 'sync'); await command(edge, 'sync');
  const folders = await edge.evaluate(`(async()=>{
    const a=(await chrome.bookmarks.search({title:${JSON.stringify(title('A'))}}))[0];
    const b=(await chrome.bookmarks.search({title:${JSON.stringify(title('B'))}}))[0];
    const c=(await chrome.bookmarks.search({title:${JSON.stringify(title('C'))}}))[0];
    return {a,b,c};})()`);
  assert.equal(folders.a.parentId, folders.c.id);
  assert.equal(folders.b.parentId, folders.a.id);
  assert.equal(folders.c.parentId, '1');
  checked('真实浏览器祖先关系交换，原生循环校验没有阻止最终层级');
  await chrome.evaluate(`chrome.bookmarks.removeTree('${ids.c}')`);
  await command(chrome, 'sync'); await command(edge, 'sync');
  assert.equal((await edge.evaluate(`chrome.bookmarks.search({url:'https://folder-cycle.example/${stamp}'})`)).length, 0);
  checked('真实浏览器递归删除的子项逐项安全传播');
  const opened = Date.now();
  await chrome.client.send('Target.createTarget', { url: 'chrome://bookmarks/' });
  let view;
  for (let attempt = 0; attempt < 30; attempt++) {
    view = await command(chrome, 'status');
    if (view.status.lastManagerSync >= opened) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(view.status.lastManagerSync >= opened);
  checked('Chrome 原生管理器标签页打开事件触发同步');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; throw error; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(run, 'folder-result.json'), JSON.stringify(report, null, 2));
  for (const browser of browsers) await browser.close();
}
