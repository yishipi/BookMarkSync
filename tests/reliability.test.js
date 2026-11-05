import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExchange, participant, settle, start, treeContents } from './helpers.js';
import { DirectoryExchange } from '../extension/lib/storage.js';
import { MAX_FILE_BYTES, makeDocument, validateDocument } from '../extension/lib/model.js';

test('三个参与者双向编辑、离线恢复后收敛，旧副本不会复活删除项', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge'), c = participant(shared, 'Chrome · 工作');
  const original = await a.api.create({ parentId: '1', title: '共同书签', url: 'https://three.example/shared' });
  await start(a); await start(b); await start(c); await settle(a, b, c);
  await c.engine.setEnabled(false);
  await c.api.update(c.api.find('1').children[0].id, { title: '离线编辑' });
  await a.api.remove(original.id);
  await a.api.create({ parentId: '1', title: 'Chrome 新增', url: 'https://three.example/chrome' });
  await b.api.create({ parentId: '2', title: 'Edge 新增', url: 'https://three.example/edge' });
  await c.api.create({ parentId: '1', title: '工作配置新增', url: 'https://three.example/work' });
  await settle(a, b);
  await c.engine.setEnabled(true); await settle(c, a, b);
  assert.deepEqual(treeContents(a.api), treeContents(b.api));
  assert.deepEqual(treeContents(a.api), treeContents(c.api));
  assert.equal((await a.engine.summary()).bookmarks, 3);
  assert.equal((await a.engine.summary()).deleted[0].title, '离线编辑');
  assert.equal(shared.files.size, 3);
});

test('账号根目录暂时消失不能改写收藏栏的顺序版本', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const account = { id: '7', parentId: '0', title: '账号收藏栏', folderType: 'bookmarks-bar', syncing: true, children: [] };
  a.api.tree[0].children.push(account);
  for (const [index, parentId] of ['1', '7', '7', '1'].entries()) await a.api.create({ parentId, title: String(index), url: `https://roots.example/${index}` });
  await start(a); await start(b); await settle(a, b);
  const before = (await a.engine.load()).records['root:toolbar'].children;
  const otherBefore = treeContents(b.api);
  a.api.tree[0].children = a.api.tree[0].children.filter(node => node.id !== '7');
  await settle(a, b);
  assert.deepEqual((await a.engine.load()).records['root:toolbar'].children, before);
  assert.deepEqual(treeContents(b.api), otherBefore);
  a.api.tree[0].children.push(account); await settle(a, b);
  assert.deepEqual((await a.engine.load()).records['root:toolbar'].children, before);
});

test('多份本地和账号根目录无法交错排列时，静止状态不反复应用和备份', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  a.api.tree[0].children.push({ id: '7', parentId: '0', title: '本地收藏栏', folderType: 'bookmarks-bar', syncing: false, children: [] });
  await a.api.create({ parentId: '1', title: '账号项', url: 'https://multiple-roots.example/account' });
  await a.api.create({ parentId: '7', title: '本地项', url: 'https://multiple-roots.example/local' });
  await start(a); await start(b); await settle(a, b);
  const local = b.api.find('1').children.find(node => node.title === '本地项');
  await b.api.move(local.id, { parentId: '1', index: 0 });
  await settle(b, a);
  const backups = shared.backups.length;
  const mutations = a.api.mutations;
  await settle(a, b);
  assert.equal(a.api.mutations, mutations);
  assert.equal(shared.backups.length, backups, '物理根目录之间不能交错的逻辑顺序不应反复应用');
});

test('账号根目录不可用时延后其子树的新项，恢复后继续且不反复备份', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const account = { id: '7', parentId: '0', title: '账号收藏栏', folderType: 'bookmarks-bar', syncing: true, children: [] };
  a.api.tree[0].children.push(account);
  const folder = await a.api.create({ parentId: '7', title: '账号资料' });
  await start(a); await start(b); await settle(a, b);
  a.api.tree[0].children = a.api.tree[0].children.filter(node => node.id !== '7');
  await settle(a, b);
  await b.api.create({ parentId: b.api.find('1').children[0].id, title: '等待根目录恢复', url: 'https://unavailable.example/new' });
  await b.engine.run();
  const backups = shared.backups.length;
  await settle(a, b);
  assert.equal(shared.backups.length, backups);
  assert.equal(a.api.find('1').children.length, 0);
  a.api.tree[0].children.push(account); await settle(a, b);
  assert.equal(a.api.find(folder.id).children[0].title, '等待根目录恢复');
});

test('恢复授权只恢复预览，不替尚未启用的用户开始同步', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  await a.api.create({ parentId: '1', title: '待接收', url: 'https://consent.example/' });
  await start(a);
  await b.engine.configure({ intervalSeconds: 30 });
  shared.denied = true;
  assert.equal((await b.engine.run({ preview: true })).status.phase, 'permission');
  shared.denied = false;
  const view = await b.engine.permissionRestored();
  assert.equal(view.status.phase, 'preview');
  assert.equal(view.config.enabled, false);
  assert.equal(b.api.find('1').children.length, 0);
  await b.engine.setEnabled(true);
  assert.equal(b.api.find('1').children[0].title, '待接收');
});

test('无效的新目录不会替换正在使用的目录或工作区', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared);
  await start(a);
  const original = await a.engine.load();
  const invalid = new MemoryExchange();
  invalid.files.set('replica-invalid-file.json', { schema: 99 });
  const key = `selection:${crypto.randomUUID()}`;
  await a.store.set(key, { name: 'bad-selection' });
  a.engine.exchangeFactory = handle => handle.name === 'bad-selection' ? invalid : shared;
  await assert.rejects(a.engine.configure({ directoryKey: key }), /格式/);
  assert.equal((await a.store.get('directory')).name, 'shared');
  assert.deepEqual(await a.engine.load(), original);
  assert.equal((await a.engine.run()).status.phase, 'ready');
});

test('切换工作区采用新参与者身份，并停在预览', async () => {
  const a = participant(new MemoryExchange());
  await start(a);
  const actor = (await a.engine.load()).actor;
  const next = new MemoryExchange();
  const key = `selection:${crypto.randomUUID()}`;
  await a.store.set(key, { name: 'next' });
  a.engine.exchangeFactory = () => next;
  const view = await a.engine.configure({ directoryKey: key });
  assert.notEqual(view.actor, actor, '不能重置同一 actor 的因果序号');
  assert.equal(view.status.phase, 'preview');
  assert.equal(view.config.enabled, false);
  assert.equal((await a.store.get('directory')).name, 'next');
});

test('回放已经完成后中断：下次无变更也必须清除中断标记', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared);
  const item = await a.api.create({ parentId: '1', title: '完成状态', url: 'https://checkpoint.example/' });
  await start(a);
  const state = await a.engine.load();
  state.pendingApply = { records: structuredClone(state.records) };
  await a.engine.save(state);
  const writes = shared.writes;
  await a.engine.run();
  assert.equal((await a.engine.load()).pendingApply, null);
  assert.equal(shared.writes, writes);
  await a.api.update(item.id, { title: '新编辑' });
  await a.engine.run();
  await a.api.update(item.id, { title: '完成状态' });
  await a.engine.run();
  assert.equal((await a.engine.summary()).bookmarks, 1);
  assert.equal(Object.values((await a.engine.load()).records).find(record => record.kind)?.title.value, '完成状态');
});

for (const action of ['edit', 'delete']) {
  test(`新建项目的检查点后中断，用户${action === 'edit' ? '修改' : '删除'}仍被捕获`, async () => {
    const shared = new MemoryExchange();
    const a = participant(shared), b = participant(shared, 'Edge');
    await start(a); await start(b);
    await a.api.create({ parentId: '1', title: '远端新增', url: 'https://new-interrupted.example/' });
    await a.engine.run();
    const get = b.api.get.bind(b.api);
    let interrupted = false;
    b.api.get = async id => {
      if (!interrupted && b.api.find(id).url === 'https://new-interrupted.example/') {
        interrupted = true;
        throw new Error('新建检查点后的中断');
      }
      return get(id);
    };
    assert.equal((await b.engine.run()).status.phase, 'error');
    const item = b.api.find('1').children[0];
    if (action === 'edit') await b.api.update(item.id, { title: '中断后编辑新项' });
    else await b.api.remove(item.id);
    await settle(b, a);
    assert.deepEqual(treeContents(a.api), treeContents(b.api));
    if (action === 'edit') assert.equal(a.api.find('1').children[0].title, '中断后编辑新项');
    else assert.equal(a.api.find('1').children.length, 0);
  });
}

test('删除应用期间重命名文件夹，恢复记录保留新标题', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const folder = await a.api.create({ parentId: '1', title: '原文件夹' });
  await start(a); await start(b); await settle(a, b);
  await a.api.removeTree(folder.id); await a.engine.run();
  const bFolder = b.api.find('1').children[0].id;
  const getChildren = b.api.getChildren.bind(b.api);
  let renamed = false;
  b.api.getChildren = async id => {
    if (id === bFolder && !renamed) { renamed = true; await b.api.update(id, { title: '删除期间重命名' }); }
    return getChildren(id);
  };
  await settle(b, a);
  assert.equal((await a.engine.summary()).deleted[0].title, '删除期间重命名');
});

test('拒绝发布端身份与文件名不一致的数据', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared);
  await start(a);
  const before = treeContents(a.api);
  shared.files.set('replica-wrong-name.json', makeDocument(await a.engine.load()));
  assert.equal((await a.engine.run()).status.phase, 'error');
  assert.deepEqual(treeContents(a.api), before);
});

test('读取内容时撤销权限，仍保留授权错误供界面恢复', async () => {
  const error = new DOMException('Permission denied', 'NotAllowedError');
  const exchange = new DirectoryExchange({ getFileHandle: async () => ({
    getFile: async () => ({ size: 0, text: async () => { throw error; } }),
  }) });
  await assert.rejects(exchange.read('replica-anything.json'), value => value === error);
});

test('同步时工作区标识丢失，不会自动写入一个新工作区', async () => {
  let writes = 0;
  const exchange = new DirectoryExchange({ getFileHandle: async (_name, options) => {
    if (options?.create) writes++;
    throw new DOMException('Missing', 'NotFoundError');
  } });
  await assert.rejects(exchange.workspace(), /标识文件丢失/);
  assert.equal(writes, 0);
});

test('目录已有副本但标识丢失，连接时拒绝重建标识', async () => {
  const exchange = new DirectoryExchange({});
  exchange.read = async () => null;
  exchange.documents = async () => [{ name: 'replica-existing.json' }];
  await assert.rejects(exchange.workspace({ create: true }), /先恢复/);
});

test('超大文档在打开写入流前拒绝，接收验证同样拒绝超限数据', async () => {
  let opened = false;
  const exchange = new DirectoryExchange({ getFileHandle: async () => { opened = true; } });
  const oversized = 'x'.repeat(MAX_FILE_BYTES);
  await assert.rejects(exchange.write('replica-oversized.json', oversized), /20 MiB/);
  assert.equal(opened, false);
  const a = participant(new MemoryExchange());
  await start(a);
  const doc = makeDocument(await a.engine.load());
  doc.unrecognizedPadding = oversized;
  assert.throws(() => validateDocument(doc, doc.workspace), /20 MiB/);
});

test('双方文档各自合规但合并超限时，在修改浏览器前停止', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  for (const [index, item] of [a, b].entries()) {
    for (let i = 0; i < 108; i++) await item.api.create({ parentId: '1', title: String(index).repeat(100000), url: `https://large.example/${index}/${i}` });
    await item.engine.configure({ intervalSeconds: 30 });
  }
  await a.engine.setEnabled(true);
  const before = treeContents(b.api);
  const view = await b.engine.setEnabled(true);
  assert.equal(view.status.phase, 'error');
  assert.match(view.status.message, /20 MiB/);
  assert.deepEqual(treeContents(b.api), before);
  assert.equal(Object.values((await b.engine.load()).records).filter(record => record.kind).length, 108,
    '超限的远端合并不能污染已保存的本地状态');
});
