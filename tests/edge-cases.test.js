import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExchange, participant, settle, start, treeContents } from './helpers.js';
import { changeFields, freshState, makeDocument, mergeDocument, stableStringify, validateDocument } from '../extension/lib/model.js';

test('两端都在发布前初始化，相同书签仍能收敛且数量不翻倍', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  for (const item of [a, b]) {
    const folder = await item.api.create({ parentId: '1', title: '共同文件夹' });
    await item.api.create({ parentId: folder.id, title: '相同书签', url: 'https://same.example/' });
    await item.engine.configure({ intervalSeconds: 30 });
  }
  await a.engine.setEnabled(true); await b.engine.setEnabled(true); await settle(a, b);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(a.api.find('1').children.length, 1);
  assert.equal(a.api.find('1').children[0].children.length, 1);
});

test('丢失对端文件不会推断为对端删除全部书签', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  await a.api.create({ parentId: '1', title: '保留', url: 'https://keep.example/' });
  await start(a); await start(b); await settle(a, b);
  shared.files.clear();
  await settle(a, b);
  assert.equal(b.api.find('1').children[0].title, '保留');
  assert.equal(shared.files.size, 2);
});

test('云端旧 ID/创建时间重新出现时，不使已删除项复活；明确的新建仍保留', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const original = await a.api.create({ parentId: '1', title: '旧项', url: 'https://old.example/' });
  await start(a); await start(b); await settle(a, b);
  await a.api.remove(original.id); await settle(a, b);
  const oldCloudCopy = await b.api.create({ parentId: '1', title: '旧项', url: 'https://old.example/' });
  b.api.find(oldCloudCopy.id).dateAdded = original.dateAdded;
  await settle(a, b);
  assert.equal(a.api.find('1').children.length, 0);
  assert.equal(b.api.find('1').children.length, 0);
  const deletionTime = (await a.engine.summary()).deleted[0].at;
  const intentional = await a.api.create({ parentId: '1', title: '旧项', url: 'https://old.example/' });
  a.api.find(intentional.id).dateAdded = deletionTime + 1000;
  await settle(a, b);
  assert.equal(b.api.find('1').children.length, 1);
});

test('账号根目录临时消失，不传播为删除，也不复制到本地根目录', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const account = { id: '7', parentId: '0', title: '账号书签栏', folderType: 'bookmarks-bar', syncing: true, children: [] };
  a.api.tree[0].children.push(account);
  await a.api.create({ parentId: '7', title: '账号数据', url: 'https://account.example/' });
  await start(a); await start(b); await settle(a, b);
  a.api.tree[0].children = a.api.tree[0].children.filter(node => node.id !== '7');
  await settle(a, b);
  assert.equal((await a.engine.summary()).deletedCount, 0);
  assert.equal(a.api.find('1').children.length, 0);
  assert.equal(b.api.find('1').children.length, 1);
  a.api.tree[0].children.push(account); await settle(a, b);
  assert.equal(a.api.find('7').children.length, 1);
});

test('应用远端标题前本地已有新编辑，保留本地新值并继续传播', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const original = await a.api.create({ parentId: '1', title: '原始', url: 'https://race.example/' });
  await start(a); await start(b); await settle(a, b);
  await a.api.update(original.id, { title: '对端编辑' }); await a.engine.run();
  const bId = b.api.find('1').children[0].id;
  const get = b.api.get.bind(b.api);
  let injected = false;
  b.api.get = async id => {
    if (id === bId && !injected) { injected = true; await b.api.update(bId, { title: '应用期间用户编辑' }); }
    return get(id);
  };
  await settle(b, a);
  assert.equal(a.api.find(original.id).title, '应用期间用户编辑');
  assert.equal(b.api.find(bId).title, '应用期间用户编辑');
});

test('中断时本地真实修改与同步回放区分处理', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const original = await a.api.create({ parentId: '1', title: '原始', url: 'https://interrupt.example/' });
  await start(a); await start(b); await settle(a, b);
  await a.api.update(original.id, { title: '远端新值' }); await a.engine.run();
  b.api.failAfter = b.api.mutations + 1;
  assert.equal((await b.engine.run()).status.phase, 'error');
  b.api.failAfter = Infinity;
  const bId = b.api.find('1').children[0].id;
  await b.api.update(bId, { title: '中断后人工修改' });
  await settle(b, a);
  assert.equal(a.api.find(original.id).title, '中断后人工修改');
});

test('系统时间回退时，本地后续编辑仍排在已观察版本之后', () => {
  const a = freshState('actor-chrome'), b = freshState('actor-edge');
  a.config.workspace = b.config.workspace = { id: crypto.randomUUID() };
  changeFields(a, 'bookmark-clock', { kind: 'bookmark', title: '旧', url: 'https://clock.example/', parent: 'root:toolbar', children: [], deleted: false }, 10000);
  mergeDocument(b, makeDocument(a));
  changeFields(b, 'bookmark-clock', { title: '回退后' }, 5000);
  mergeDocument(a, makeDocument(b));
  assert.equal(a.records['bookmark-clock'].title.value, '回退后');
});

test('原生批量导入复用了旧 ID 且类型变化时，重新匹配而不污染书签类型', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const original = await a.api.create({ parentId: '1', title: '保留原项', url: 'https://identity.example/' });
  await start(a); await start(b); await settle(a, b);
  const reused = a.api.find(original.id);
  delete reused.url; reused.title = '新文件夹'; reused.children = []; reused.dateAdded += 1000;
  await a.api.create({ parentId: '1', title: '保留原项', url: 'https://identity.example/' });
  await settle(a, b);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(b.api.find('1').children.length, 2);
  const document = makeDocument(await a.engine.load());
  assert.equal(validateDocument(document, document.workspace), document);
});

test('原生批量导入复用了 ID、创建时间改变时，保留两项并重绑定旧项', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const original = await a.api.create({ parentId: '1', title: '原项', url: 'https://original.example/' });
  await start(a); await start(b); await settle(a, b);
  Object.assign(a.api.find(original.id), { title: '另一个项目', url: 'https://another.example/', dateAdded: original.dateAdded + 1000 });
  await a.api.create({ parentId: '1', title: '原项', url: 'https://original.example/' });
  await settle(a, b);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(b.api.find('1').children.length, 2);
});

test('拒绝原型键，避免外部 JSON 改写内部对象', () => {
  const state = freshState('actor-chrome'); state.config.workspace = { id: crypto.randomUUID() };
  const document = makeDocument(state);
  document.records = JSON.parse('{"__proto__":{}}');
  assert.throws(() => validateDocument(document, document.workspace));
  document.records = {}; document.vector = JSON.parse('{"constructor":1}');
  assert.throws(() => validateDocument(document, document.workspace));
});

test('文件夹祖先关系交换：父文件夹先到达最终位置', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const parent = await a.api.create({ parentId: '1', title: 'A' });
  const middle = await a.api.create({ parentId: parent.id, title: 'B' });
  const inner = await a.api.create({ parentId: middle.id, title: 'C' });
  await a.api.create({ parentId: inner.id, title: '内容', url: 'https://nested.example/' });
  await start(a); await start(b); await settle(a, b);
  await a.api.move(inner.id, { parentId: '1' });
  await a.api.move(parent.id, { parentId: inner.id });
  await settle(a, b);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(b.api.find('1').children[0].title, 'C');
  assert.ok(b.api.find('1').children[0].children.some(node => node.title === 'A'));
});

test('祖先关系交换在首次移动后中断，恢复时不保留临时目录位置', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const parent = await a.api.create({ parentId: '1', title: 'A' });
  const middle = await a.api.create({ parentId: parent.id, title: 'B' });
  const inner = await a.api.create({ parentId: middle.id, title: 'C' });
  await start(a); await start(b); await settle(a, b);
  await a.api.move(inner.id, { parentId: '1' });
  await a.api.move(parent.id, { parentId: inner.id });
  await a.engine.run();
  b.api.failAfter = b.api.mutations + 1;
  assert.equal((await b.engine.run()).status.phase, 'error');
  b.api.failAfter = Infinity;
  await settle(b, a);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(b.api.find('1').children[0].title, 'C');
  assert.equal(b.api.find('2').children.length, 0);
});

test('应用期间用户移动文件夹，随后捕获本地新位置而不是覆盖它', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const folder = await a.api.create({ parentId: '1', title: '原文件夹' });
  await start(a); await start(b); await settle(a, b);
  await a.api.update(folder.id, { title: '远端重命名' }); await a.engine.run();
  const bFolder = b.api.find('1').children[0].id;
  const read = b.api.getTree.bind(b.api);
  let calls = 0;
  b.api.getTree = async () => {
    if (++calls === 2) await b.api.move(bFolder, { parentId: '2' });
    return read();
  };
  await settle(b, a);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.equal(b.api.find('2').children[0].title, '远端重命名');
});

test('互相交换后版本保持静止，不因原生同步回声形成循环', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  for (let i = 0; i < 100; i++) await a.api.create({ parentId: i % 2 ? '1' : '2', title: `书签 ${i}`, url: `https://site.example/${i}` });
  await start(a); await start(b); await settle(a, b);
  const before = stableStringify((await a.engine.load()).records);
  const writes = shared.writes;
  for (let i = 0; i < 5; i++) await settle(b, a);
  assert.equal(stableStringify((await a.engine.load()).records), before);
  assert.equal(shared.writes, writes);
});

test('保存同一目录的名称或间隔，不会意外暂停已有自动同步', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared);
  await start(a);
  const view = await a.engine.configure({ label: '我的 Chrome', intervalSeconds: 60 });
  assert.equal(view.config.enabled, true);
  assert.equal(view.config.label, '我的 Chrome');
  assert.equal(view.config.intervalSeconds, 60);
});

test('没有移动根目录时创建普通映射文件夹，用户删除该文件夹会传播删除', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  a.api.tree[0].children = a.api.tree[0].children.filter(root => root.id !== '3');
  await b.api.create({ parentId: '3', title: '手机书签', url: 'https://mobile.example/' });
  await start(a); await start(b); await settle(a, b);
  const virtual = a.api.find('2').children.find(node => node.children);
  assert.ok(virtual);
  assert.equal(virtual.children[0].title, '手机书签');
  await a.api.removeTree(virtual.id); await settle(a, b);
  assert.equal(b.api.find('3').children.length, 0);
  assert.equal(a.api.find('2').children.length, 0);
});
