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

// Pause automatic exchange so both real browsers edit the same starting list.
async function verifyConcurrentInserts(chrome, edge) {
  await command(chrome, 'pause'); await command(edge, 'pause');
  let expected;
  for (const [first, second] of [[chrome, edge], [edge, chrome]]) {
    const name = JSON.stringify(title(first === chrome ? 'Chrome先发布' : 'Edge先发布'));
    const chromeFolder = await chrome.evaluate(`(async () => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: ${name} });
      for (const title of ['A', 'B']) await chrome.bookmarks.create({ parentId: folder.id, title, url: 'https://gap.example/' + title });
      return folder.id;
    })()`);
    await command(chrome, 'sync'); await command(edge, 'sync');
    const edgeFolder = (await edge.evaluate(`chrome.bookmarks.search({ title: ${name} })`))[0].id;
    for (const [browser, folder, label] of [[chrome, chromeFolder, 'X'], [edge, edgeFolder, 'Y']]) {
      const item = { parentId: folder, index: 1, title: label, url: 'https://gap.example/' + label };
      await browser.evaluate(`chrome.bookmarks.create(${JSON.stringify(item)})`);
    }
    await command(first, 'sync'); await command(second, 'sync'); await command(first, 'sync');
    for (const [browser, folder] of [[chrome, chromeFolder], [edge, edgeFolder]]) {
      const titles = await browser.evaluate(`chrome.bookmarks.getChildren(${JSON.stringify(folder)}).then(items => items.map(item => item.title))`);
      assert.equal(titles[0], 'A'); assert.equal(titles.at(-1), 'B');
      assert.deepEqual(titles.slice(1, -1).sort(), ['X', 'Y']);
      expected ??= titles;
      assert.deepEqual(titles, expected);
      assert.equal((await command(browser, 'sync')).status.plan.total, 0);
    }
  }
  await command(chrome, 'enable'); await command(edge, 'enable');
  checked('两端在同一间隙插入，交换发布顺序后仍得到 ' + expected.join(' ') + '，再次同步为零项');
}

// Hold the reply to one real Edge move so the browser closes with a durable
// checkpoint and a partially reordered folder. The hook lives only in this worker.
async function verifyInterruptedReorder(chrome, edge) {
  await command(edge, 'pause');
  const folderTitle = JSON.stringify(title('排序恢复'));
  const folder = await chrome.evaluate(`(async () => {
    const folder = await chrome.bookmarks.create({ parentId: '1', title: ${folderTitle} });
    for (const title of ['A', 'B', 'C', 'D']) {
      await chrome.bookmarks.create({ parentId: folder.id, title, url: 'https://folder-order.example/' + title });
    }
    return folder.id;
  })()`);
  await command(chrome, 'sync'); await command(edge, 'sync');
  const edgeFolder = (await edge.evaluate(`chrome.bookmarks.search({ title: ${folderTitle} })`))[0].id;
  const titles = (browser, id) => browser.evaluate(
    `chrome.bookmarks.getChildren(${JSON.stringify(id)}).then(items => items.map(item => item.title))`);
  assert.deepEqual(await titles(edge, edgeFolder), ['A', 'B', 'C', 'D']);
  await chrome.evaluate(`(async () => {
    const items = await chrome.bookmarks.getChildren(${JSON.stringify(folder)});
    for (const item of items.slice(1)) await chrome.bookmarks.move(item.id, { parentId: item.parentId, index: 0 });
  })()`);
  await command(chrome, 'sync');
  const { targetInfos } = await edge.client.send('Target.getTargets');
  const worker = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${edge.extensionId}/`));
  const { sessionId } = await edge.client.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await edge.client.evaluate(sessionId, `(() => {
    const move = chrome.bookmarks.move.bind(chrome.bookmarks);
    chrome.bookmarks.move = async (id, target) => {
      const result = await move(id, target);
      if (target.parentId === ${JSON.stringify(edgeFolder)} && Number.isInteger(target.index)) return new Promise(() => {});
      return result;
    };
  })()`);
  await edge.evaluate("void chrome.runtime.sendMessage({type: 'enable'}).catch(() => {})");
  for (let i = 0; i < 100 && (await titles(edge, edgeFolder))[0] !== 'D'; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(await titles(edge, edgeFolder), ['D', 'A', 'B', 'C']);
  assert.equal(await edge.evaluate(`(async () => {
    const { database } = await import('./lib/storage.js');
    const pending = (await database.get('state')).pendingApply;
    const checkpoint = await database.get('reorderCheckpoint');
    return !!pending && pending.id === checkpoint?.id && !!checkpoint.reorders[${JSON.stringify(edgeFolder)}];
  })()`), true);
  await edge.close();
  const restarted = await launchBrowser('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', edge.profile, path.join(root, 'extension'));
  browsers[1] = restarted;
  await command(restarted, 'sync'); await command(chrome, 'sync');
  assert.deepEqual(await titles(restarted, edgeFolder), ['D', 'C', 'B', 'A']);
  assert.deepEqual(await titles(chrome, folder), ['D', 'C', 'B', 'A']);
  assert.equal((await command(restarted, 'sync')).status.plan.total, 0);
  checked('真实 Edge 在排序中途关闭，重启后完成剩余移动，两端一致且再次同步为零项');
}

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
  await verifyConcurrentInserts(chrome, edge);
  await verifyInterruptedReorder(chrome, edge);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; throw error; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(run, 'folder-result.json'), JSON.stringify(report, null, 2));
  for (const browser of browsers) await browser.close();
}
