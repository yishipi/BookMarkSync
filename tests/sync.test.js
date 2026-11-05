import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExchange, participant, settle, start, treeContents } from './helpers.js';
import { changeFields, freshState, makeDocument, materialize, mergeDocument, stableStringify, validateDocument } from '../extension/lib/model.js';

async function pair() {
  const shared = new MemoryExchange();
  const chrome = participant(shared);
  const edge = participant(shared, 'Edge');
  return { shared, chrome, edge };
}

test('首次并集：相同项配对，保留两端独有项及重复数量', async () => {
  const { shared, chrome, edge } = await pair();
  for (const item of [chrome, edge]) await item.api.create({ parentId: '1', title: '相同', url: 'https://example.com/' });
  await chrome.api.create({ parentId: '1', title: '相同', url: 'https://example.com/' });
  await chrome.api.create({ parentId: '1', title: 'Chrome', url: 'https://chrome.example/' });
  await edge.api.create({ parentId: '2', title: 'Edge', url: 'https://edge.example/' });
  const before = treeContents(chrome.api);
  await chrome.engine.configure({ intervalSeconds: 30 });
  assert.equal((await chrome.engine.summary()).config.enabled, false);
  assert.deepEqual(treeContents(chrome.api), before, '预览不能修改书签');
  await start(chrome); await start(edge); await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(chrome.api.find('1').children.length, 3);
  assert.equal(chrome.api.find('2').children.length, 1);
  const writes = shared.writes;
  const vector = stableStringify((await chrome.engine.load()).vector);
  await settle(chrome, edge);
  assert.equal(shared.writes, writes, '静止状态不得反复发布');
  assert.equal(stableStringify((await chrome.engine.load()).vector), vector, '同步事件不能产生新编辑');
});

test('两端不同字段编辑：标题和位置一起保留', async () => {
  const { chrome, edge } = await pair();
  const a = await chrome.api.create({ parentId: '1', title: '旧标题', url: 'https://example.com/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  const b = edge.api.find('1').children[0];
  await chrome.api.update(a.id, { title: '新标题' });
  await edge.api.move(b.id, { parentId: '2' });
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(chrome.api.find('2').children[0].title, '新标题');
});

test('同字段并发冲突收敛，并可恢复另一版', async () => {
  const { chrome, edge } = await pair();
  const a = await chrome.api.create({ parentId: '1', title: '起点', url: 'https://example.com/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  await chrome.api.update(a.id, { title: 'Chrome 修改' });
  await edge.api.update(edge.api.find('1').children[0].id, { title: 'Edge 修改' });
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  const view = await chrome.engine.summary();
  assert.ok(view.conflicts.some(item => item.field === 'title'));
  const conflict = view.conflicts.find(item => item.field === 'title');
  await chrome.engine.restore(conflict.id, conflict.key);
  await settle(chrome, edge);
  assert.equal(chrome.api.find('1').children[0].title, conflict.loser.value);
  assert.ok(!(await chrome.engine.summary()).conflicts.some(item => item.key === conflict.key));
  assert.ok(!(await edge.engine.summary()).conflicts.some(item => item.key === conflict.key));
});

test('删除和并发修改：删除传播，恢复时保留最新内容', async () => {
  const { shared, chrome, edge } = await pair();
  const a = await chrome.api.create({ parentId: '1', title: '起点', url: 'https://example.com/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  await chrome.api.remove(a.id);
  await edge.api.update(edge.api.find('1').children[0].id, { title: '未收到删除时的编辑' });
  await settle(chrome, edge);
  assert.equal(chrome.api.find('1').children.length, 0);
  assert.equal(edge.api.find('1').children.length, 0);
  const deleted = (await chrome.engine.summary()).deleted[0];
  assert.equal(deleted.title, '未收到删除时的编辑');
  await chrome.engine.restore(deleted.id);
  await settle(chrome, edge);
  assert.equal(edge.api.find('1').children[0].title, deleted.title);
  assert.ok(shared.backups.length);
});

test('删除整个文件夹可恢复同次删除的子树', async () => {
  const { chrome, edge } = await pair();
  const folder = await chrome.api.create({ parentId: '1', title: '资料' });
  const nested = await chrome.api.create({ parentId: folder.id, title: '子文件夹' });
  await chrome.api.create({ parentId: nested.id, title: '书签', url: 'https://example.com/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  await chrome.api.removeTree(folder.id); await settle(chrome, edge);
  const trash = (await chrome.engine.summary()).deleted;
  await chrome.engine.restore(trash.find(item => item.title === '资料').id);
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(edge.api.find('1').children[0].children[0].children[0].title, '书签');
});

test('删除文件夹与对端新增子项冲突：新子项移至其他收藏夹', async () => {
  const { chrome, edge } = await pair();
  const folder = await chrome.api.create({ parentId: '1', title: '资料' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  await chrome.api.removeTree(folder.id);
  await edge.api.create({ parentId: edge.api.find('1').children[0].id, title: '新项', url: 'https://new.example/' });
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(edge.api.find('2').children[0].title, '新项');
});

test('移动和排序传播，网址的查询参数及片段保持原样', async () => {
  const { chrome, edge } = await pair();
  for (let i = 0; i < 4; i++) await chrome.api.create({ parentId: '1', title: String(i), url: `https://example.com/?q=${i}#tab` });
  await start(chrome); await start(edge); await settle(chrome, edge);
  const nodes = edge.api.find('1').children;
  await edge.api.move(nodes[3].id, { parentId: '1', index: 0 });
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(chrome.api.find('1').children[0].url, 'https://example.com/?q=3#tab');
});

test('云同步用相同内容替换原生 ID：重绑定，不重复导入', async () => {
  const { chrome, edge } = await pair();
  const original = await chrome.api.create({ parentId: '1', title: '云同步书签', url: 'https://cloud.example/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  const vector = stableStringify((await chrome.engine.load()).vector);
  await chrome.api.remove(original.id);
  await chrome.api.create({ parentId: '1', title: '云同步书签', url: 'https://cloud.example/' });
  await settle(chrome, edge);
  assert.equal(chrome.api.find('1').children.length, 1);
  assert.equal(edge.api.find('1').children.length, 1);
  assert.equal(stableStringify((await chrome.engine.load()).vector), vector);
});

test('暂停、离线编辑、恢复目录权限后补同步', async () => {
  const { shared, chrome, edge } = await pair();
  await start(chrome); await start(edge);
  await chrome.engine.setEnabled(false);
  await chrome.api.create({ parentId: '1', title: '暂停时新增', url: 'https://paused.example/' });
  await chrome.engine.run(); await edge.engine.run();
  assert.equal(edge.api.find('1').children.length, 0);
  await chrome.engine.setEnabled(true); await settle(chrome, edge);
  shared.denied = true;
  await edge.api.update(edge.api.find('1').children[0].id, { title: '离线修改' });
  assert.equal((await edge.engine.run()).status.phase, 'permission');
  shared.denied = false; await settle(chrome, edge);
  assert.equal(chrome.api.find('1').children[0].title, '离线修改');
});

test('损坏的交换文件不导致删除，修复文件后继续', async () => {
  const { shared, chrome, edge } = await pair();
  await chrome.api.create({ parentId: '1', title: '保留', url: 'https://example.com/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  const before = treeContents(chrome.api);
  shared.files.set('replica-bad-file.json', { schema: 99 });
  assert.equal((await chrome.engine.run()).status.phase, 'error');
  assert.deepEqual(treeContents(chrome.api), before);
  shared.files.delete('replica-bad-file.json');
  await settle(chrome, edge);
});

test('应用创建中断后恢复：不重复创建、不把同步操作当用户编辑', async () => {
  const { chrome, edge } = await pair();
  await start(chrome); await start(edge);
  const folder = await chrome.api.create({ parentId: '1', title: '新文件夹' });
  await chrome.api.create({ parentId: folder.id, title: '新内容', url: 'https://example.com/' });
  await chrome.engine.run();
  edge.api.failAfter = edge.api.mutations + 1;
  assert.equal((await edge.engine.run()).status.phase, 'error');
  edge.api.failAfter = Infinity;
  await settle(chrome, edge);
  assert.deepEqual(treeContents(chrome.api), treeContents(edge.api));
  assert.equal(edge.api.find('1').children.length, 1);
  assert.equal(edge.api.find('1').children[0].children.length, 1);
});

test('不修改企业管理收藏夹', async () => {
  const { chrome, edge } = await pair();
  chrome.api.tree[0].children.push({ id: '8', parentId: '0', title: '企业', folderType: 'managed', unmodifiable: 'managed', children: [
    { id: '9', parentId: '8', title: '企业网址', url: 'https://company.example/' },
  ] });
  await start(chrome); await start(edge); await settle(chrome, edge);
  assert.equal(chrome.api.find('9').title, '企业网址');
  assert.equal((await chrome.engine.summary()).bookmarks, 0);
});

test('根目录多份 local/account 共存时，不把现有书签迁移到另一份根目录', async () => {
  const { chrome, edge } = await pair();
  chrome.api.tree[0].children.push({ id: '7', parentId: '0', title: '本地书签栏', folderType: 'bookmarks-bar', syncing: false, children: [] });
  const local = await chrome.api.create({ parentId: '7', title: '本地', url: 'https://local.example/' });
  await chrome.api.create({ parentId: '1', title: '账号', url: 'https://account.example/' });
  await start(chrome); await start(edge); await settle(chrome, edge);
  assert.equal(chrome.api.find(local.id).parentId, '7');
  assert.equal(edge.api.find('1').children.length, 2);
});

test('合并满足交换律、幂等性，循环移动确定地修复', () => {
  const a = freshState('actor-chrome'), b = freshState('actor-edge');
  for (const state of [a, b]) state.config.workspace = { id: crypto.randomUUID() };
  changeFields(a, 'folder-first', { kind: 'folder', title: 'A', url: null, parent: 'root:other', children: [], deleted: false });
  changeFields(a, 'folder-second', { kind: 'folder', title: 'B', url: null, parent: 'root:other', children: [], deleted: false });
  mergeDocument(b, makeDocument(a));
  changeFields(a, 'folder-first', { parent: 'folder-second' });
  changeFields(b, 'folder-second', { parent: 'folder-first' });
  const aa = structuredClone(a), bb = structuredClone(b);
  mergeDocument(aa, makeDocument(b)); mergeDocument(bb, makeDocument(a));
  assert.equal(stableStringify(aa.records), stableStringify(bb.records));
  const old = stableStringify(aa.records);
  mergeDocument(aa, makeDocument(b)); assert.equal(stableStringify(aa.records), old);
  assert.equal(materialize(aa).repairs.length, 1);
  assert.deepEqual(materialize(aa), materialize(bb));
});

test('拒绝类型不一致、无效版本、工作区不符和超前时间', () => {
  const state = freshState('actor-chrome'); state.config.workspace = { id: crypto.randomUUID() };
  changeFields(state, 'bookmark-test', { kind: 'bookmark', title: '书签', url: 'https://example.com/', parent: 'root:toolbar', children: [], deleted: false });
  const doc = makeDocument(state);
  assert.equal(validateDocument(doc, doc.workspace), doc);
  assert.throws(() => validateDocument(doc, 'wrong'));
  const invalid = structuredClone(doc); invalid.records['bookmark-test'].kind.value = 'folder';
  assert.throws(() => validateDocument(invalid, doc.workspace));
  const future = structuredClone(doc); future.records['bookmark-test'].title.stamp.time += 172800000;
  assert.throws(() => validateDocument(future, doc.workspace));
});

test('没有显式位置的新项按固定字符顺序排列，不依赖浏览器界面语言', () => {
  const state = freshState('actor-chrome');
  for (const id of ['aaaaaaaa0999', 'aaaaaaaa-9999']) {
    changeFields(state, id, { kind: 'bookmark', title: id, url: 'https://example.com/', parent: 'root:toolbar', children: [], deleted: false });
  }
  assert.deepEqual(materialize(state).children['root:toolbar'], ['aaaaaaaa-9999', 'aaaaaaaa0999']);
});
