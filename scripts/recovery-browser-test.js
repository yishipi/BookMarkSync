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
assert.ok(run, '请先运行 npm run test:browser，生成通过验证的独立测试配置。');
const browser = await launchBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', path.join(run, 'Chrome'), path.join(root, 'extension'));
const origin = `chrome-extension://${browser.extensionId}/`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), run };
function readState() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bookmark-sync-local-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('kv');
      const get = tx.objectStore('kv').get('state');
      get.onsuccess = () => resolve(get.result);
      tx.oncomplete = () => db.close();
    };
  });
}
async function worker() {
  return (await browser.client.send('Target.getTargets')).targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(origin));
}
async function state() {
  const target = await worker();
  if (!target) return null;
  const { sessionId } = await browser.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try { return await browser.client.evaluate(sessionId, `(${readState.toString()})()`); }
  finally { await browser.client.send('Target.detachFromTarget', { sessionId }); }
}
try {
  const before = await state();
  assert.equal(before.status.phase, 'ready');
  const targets = (await browser.client.send('Target.getTargets')).targetInfos;
  for (const target of targets.filter(target => target.type === 'page' && target.url.startsWith(origin))) {
    await browser.client.send('Target.closeTarget', { targetId: target.targetId });
  }
  await pause(1500);
  const target = await worker();
  assert.ok(target);
  const stoppedAt = Date.now();
  const closed = await browser.client.send('Target.closeTarget', { targetId: target.targetId });
  assert.equal(closed.success, true, '浏览器必须真正停止后台，才能验证唤醒');
  await pause(200);
  assert.equal(await worker(), undefined, '后台已停止，不能靠持续调试保持存活');
  console.log('PASS 设置页全部关闭，后台已被真正停止');
  let after;
  while (Date.now() - stoppedAt < 60000) {
    if (await worker()) {
      after = await state();
      if (after.status.lastSync > stoppedAt) break;
    }
    await pause(500);
  }
  assert.ok(after?.status.lastSync > stoppedAt, '定时任务必须在没有页面和调试会话时唤醒后台');
  assert.equal(after.status.phase, 'ready');
  assert.equal(after.actor, before.actor);
  report.passed = true;
  report.wakeDelayMs = after.status.lastSync - stoppedAt;
  report.reason = after.status.reason;
  console.log(`PASS 后台由 ${after.status.reason} 自动唤醒，同步状态保留，等待 ${report.wakeDelayMs} ms`);
  const backupDirectory = path.join(run, 'shared/backups');
  for (const name of await readdir(backupDirectory)) {
    const backup = JSON.parse(await readFile(path.join(backupDirectory, name), 'utf8'));
    assert.equal(backup.schema, 1); assert.ok(Array.isArray(backup.tree));
  }
  console.log('PASS 实际磁盘备份均为有效书签树');
} catch (error) { report.passed = false; report.error = error.stack; throw error; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(run, 'recovery-result.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
