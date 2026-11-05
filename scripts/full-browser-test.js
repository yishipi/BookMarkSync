import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchBrowser } from './cdp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = path.join(root, 'extension');
const run = path.join(root, 'work', `browser-${Date.now()}`);
const shared = path.join(run, 'shared').replaceAll('\\', '/');
await mkdir(shared, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const extensionId = [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
const origin = `chrome-extension://${extensionId}/`;
const executables = {
  Chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  Edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const browsers = [];
const evidence = { startedAt: new Date().toISOString(), run, authorization: 'Only isolated test profiles: pre-seeded persistent read/write grant; actual directory handle acquired through CDP drag/drop. Native permission dialog is not automated.', checks: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checked = name => { evidence.checks.push(name); console.log(`PASS ${name}`); };

async function workerEval(browser, expression) {
  for (let retry = 0; retry < 80; retry++) {
    const { targetInfos } = await browser.client.send('Target.getTargets');
    const worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(origin));
    if (worker) {
      const { sessionId } = await browser.client.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      try { return await browser.client.evaluate(sessionId, expression); }
      finally { await browser.client.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    }
    await pause(500);
  }
  throw new Error('Extension worker did not wake');
}

async function command(browser, type, fields = {}) {
  const result = await browser.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...fields })})`);
  assert.equal(result.ok, true, result.error);
  assert.notEqual(result.result.status?.phase, 'error', result.result.status?.message);
  return result.result;
}

async function closeSettings(browser) {
  const { targetInfos } = await browser.client.send('Target.getTargets');
  for (const info of targetInfos.filter(target => target.type === 'page' && target.url.startsWith(origin))) {
    await browser.client.send('Target.closeTarget', { targetId: info.targetId });
  }
}

async function waitFor(check, description, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await pause(1000);
  }
  throw new Error(`Timeout: ${description}`);
}

async function find(browser, url) {
  return workerEval(browser, `chrome.bookmarks.search({url:${JSON.stringify(url)}})`);
}

function readStateInWorker() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bookmark-sync-local-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv');
      const request = tx.objectStore('kv').get('state');
      request.onsuccess = () => resolve(request.result);
      tx.oncomplete = () => db.close();
    };
  });
}

async function screenshot(browser, name, width = 1200, dark = false) {
  await browser.client.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false }, browser.sessionId);
  await browser.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, browser.sessionId);
  await pause(100);
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Settings must fit viewport');
  const image = await browser.client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, browser.sessionId);
  await writeFile(path.join(run, `${name}.png`), Buffer.from(image.data, 'base64'));
}

try {
  for (const [name, executable] of Object.entries(executables)) {
    const profile = path.join(run, name);
    await mkdir(path.join(profile, 'Default'), { recursive: true });
    await writeFile(path.join(profile, 'First Run'), '');
    await writeFile(path.join(profile, 'FirstLaunchAfterInstallation'), '');
    if (name === 'Edge') await writeFile(path.join(profile, 'Local State'), JSON.stringify({
      ie_react: { has_done_one_time_ie_import: true },
      fre: { has_first_visible_browser_session_completed: true, oem_bookmarks_set: true, hide_first_run_experience: true },
      browser: { first_run_finished: true },
    }));
    // Equivalent persisted chooser grant, scoped ONLY to this extension and this
    // disposable directory. Never edit a person's Chrome/Edge profile.
    await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ browser: { first_run_finished: true },
      import_at_first_run: 4, is_auto_import_done: true, import_bookmarks: false, import_history: false,
      import_saved_passwords: false, import_search_engine: false, profile: { content_settings: { exceptions: {
      file_system_access_extended_permission: { [origin + ',*']: { setting: 1 } },
      file_system_access_chooser_data: { [origin + ',*']: { setting: { 'chosen-objects': [
        { 'display-name': 'shared', 'is-directory': true, path: shared, readable: true, writable: true },
      ] } } },
    } } } }));
    const browser = await launchBrowser(executable, profile, extension);
    browsers.push(browser);
    const version = await browser.client.send('Browser.getVersion');
    evidence[name] = version.product;
    console.log(`${name}: ${version.product}, extension ${browser.extensionId}`);
    assert.equal(await browser.evaluate('typeof showDirectoryPicker'), 'function');
    const tree = await browser.evaluate('chrome.bookmarks.getTree()');
    assert.ok(tree[0].children.length);
    assert.equal((await command(browser, 'status')).status.phase, 'setup');
    await browser.evaluate(`
      document.addEventListener('dragover', e => e.preventDefault());
      document.addEventListener('drop', e => { e.preventDefault();
        window.pickedDirectory = e.dataTransfer.items[0].getAsFileSystemHandle().then(async handle => {
          const {database}=await import('./lib/storage.js');
          const directoryKey='selection:'+crypto.randomUUID();
          await database.set(directoryKey,handle);
          return {directoryKey,name:handle.name,permission:await handle.queryPermission({mode:'readwrite'})};
        });
      }); true`);
    const data = { items: [], files: [shared], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await browser.client.send('Input.dispatchDragEvent', { type, x: 200, y: 200, data }, browser.sessionId);
    const selection = await browser.evaluate('window.pickedDirectory');
    assert.equal(selection.permission, 'granted');
    assert.equal(await browser.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');return !!(await database.get('directory'))})()`), false);
    await browser.evaluate(`chrome.bookmarks.create({parentId:'1',title:'${name} 初始书签',url:'https://${name.toLowerCase()}.example/initial'})`);
    assert.equal((await command(browser, 'configure', { settings: { directoryKey: selection.directoryKey, label: name, intervalSeconds: 30 } })).status.phase, 'preview');
    await browser.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');await database.remove(${JSON.stringify(selection.directoryKey)})})()`);
    await screenshot(browser, `${name}-preview`);
    await command(browser, 'enable');
    checked(`${name} 真正目录句柄、IndexedDB 保存、预览、启用及磁盘写入`);
  }
  const [chrome, edge] = browsers;
  for (let i = 0; i < 2; i++) { await command(chrome, 'sync'); await command(edge, 'sync'); }
  assert.equal((await find(chrome, 'https://edge.example/initial')).length, 1);
  assert.equal((await find(edge, 'https://chrome.example/initial')).length, 1);
  checked('真实 Chrome / Edge 首次双向合并，无重复');
  assert.equal((await command(chrome, 'status')).bookmarks, 2, '测试配置不能自动导入真实浏览器数据');
  await screenshot(chrome, 'Chrome-ready');
  await screenshot(edge, 'Edge-mobile', 390);
  await screenshot(edge, 'Edge-dark', 1200, true);
  checked('设置页宽屏、窄屏及深色模式无横向溢出');
  await closeSettings(chrome); await closeSettings(edge);
  await workerEval(chrome, `chrome.bookmarks.create({parentId:'1',title:'自动发布与接收',url:'https://automatic.example/'})`);
  await waitFor(async () => (await find(edge, 'https://automatic.example/')).length === 1, 'automatic sync');
  checked('关闭所有设置页：书签事件自动发布，对端周期任务自动接收');
  const item = (await find(edge, 'https://automatic.example/'))[0];
  await workerEval(edge, `chrome.bookmarks.update('${item.id}',{title:'Edge 编辑并移动'})`);
  await workerEval(edge, `chrome.bookmarks.move('${item.id}',{parentId:'2'})`);
  await waitFor(async () => { const found = await find(chrome, 'https://automatic.example/'); return found[0]?.title === 'Edge 编辑并移动' && found[0]?.parentId === '2'; }, 'reverse edit sync');
  checked('反向标题修改及移动自动传播');
  await workerEval(chrome, `chrome.bookmarks.create({parentId:'1',title:'管理器触发',url:'https://manager.example/'})`);
  await pause(2200);
  const managerOpenedAt = Date.now();
  await edge.client.send('Target.createTarget', { url: 'edge://favorites/' });
  await waitFor(async () => (await find(edge, 'https://manager.example/')).length === 1, 'manager trigger', 10000);
  const edgeStatus = (await workerEval(edge, `(${readStateInWorker.toString()})()`)).status;
  await waitFor(async () => (await workerEval(edge, `(${readStateInWorker.toString()})()`)).status.lastManagerSync >= managerOpenedAt,
    'manager event completion', 10000);
  checked('管理器标签页确实触发同步');
  await workerEval(edge, `chrome.bookmarks.remove('${item.id}')`);
  await waitFor(async () => (await find(chrome, 'https://automatic.example/')).length === 0, 'delete propagation');
  checked('删除自动传播，旧快照未使书签复活');
  const before = await workerEval(chrome, `(${readStateInWorker.toString()})()`);
  await chrome.close();
  const restarted = await launchBrowser(executables.Chrome, chrome.profile, extension);
  browsers[0] = restarted;
  evidence.ChromeTemporaryExtensionReloaded = restarted.temporaryReload;
  const permission = await restarted.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');const h=await database.get('directory');return h.queryPermission({mode:'readwrite'})})()`);
  assert.equal(permission, 'granted');
  const after = await command(restarted, 'status');
  assert.equal(after.actor, before.actor);
  assert.equal(after.status.phase, 'ready');
  await closeSettings(restarted);
  await workerEval(restarted, `chrome.bookmarks.create({parentId:'1',title:'重启后仍自动',url:'https://restart.example/'})`);
  await waitFor(async () => (await find(edge, 'https://restart.example/')).length === 1, 'restart automatic sync');
  checked('Chrome 重启并重新挂载临时测试扩展后，目录授权、身份和自动同步保留');
  const edgeBefore = await workerEval(edge, `(${readStateInWorker.toString()})()`);
  await edge.close();
  const edgeRestarted = await launchBrowser(executables.Edge, edge.profile, extension);
  browsers[1] = edgeRestarted;
  evidence.EdgeTemporaryExtensionReloaded = edgeRestarted.temporaryReload;
  assert.equal((await command(edgeRestarted, 'status')).actor, edgeBefore.actor);
  assert.equal(await edgeRestarted.evaluate(`(async()=>{const {database}=await import('./lib/storage.js');return (await database.get('directory')).queryPermission({mode:'readwrite'})})()`), 'granted');
  await closeSettings(edgeRestarted);
  await workerEval(edgeRestarted, `chrome.bookmarks.create({parentId:'2',title:'Edge 重启后自动',url:'https://edge-restart.example/'})`);
  await waitFor(async () => (await find(restarted, 'https://edge-restart.example/')).length === 1, 'Edge restart automatic sync');
  checked('Edge 重启并重新挂载临时测试扩展后，无需重新选目录或授权即可反向同步');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = error.stack;
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2));
  for (const browser of browsers) await browser.close();
  console.log(`浏览器验证记录：${run}`);
}
