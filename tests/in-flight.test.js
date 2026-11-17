import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExchange, participant, settle, start, treeContents } from './helpers.js';

for (const kind of ['bookmark', 'folder']) {
  test(`应用开始前刚删除的${kind === 'folder' ? '文件夹子树' : '书签'}不被重新创建`, async () => {
    const shared = new MemoryExchange();
    const a = participant(shared), b = participant(shared, 'Edge');
    const original = await a.api.create({ parentId: '1', title: '原始',
      ...(kind === 'bookmark' ? { url: 'https://late-delete.example/' } : {}) });
    if (kind === 'folder') await a.api.create({ parentId: original.id, title: '子项', url: 'https://late-delete.example/child' });
    await start(a); await start(b); await settle(a, b);
    await a.api.update(original.id, { title: '对端新标题' });
    await a.engine.run();
    const localId = b.api.find('1').children[0].id;
    const getTree = b.api.getTree.bind(b.api);
    let captures = 0;
    b.api.getTree = async () => {
      if (++captures === 2) await b.api.removeTree(localId);
      return getTree();
    };
    await settle(b, a);
    assert.deepEqual(treeContents(b.api), treeContents(a.api));
    assert.equal(b.api.find('1').children.length, 0);
    assert.equal((await b.engine.summary()).deletedCount, kind === 'folder' ? 2 : 1);
  });
}

test('应用开始前删除父文件夹，远端新增子项转入其他收藏夹', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const folder = await a.api.create({ parentId: '1', title: '资料' });
  await start(a); await start(b); await settle(a, b);
  await a.api.create({ parentId: folder.id, title: '远端新增', url: 'https://late-delete.example/new' });
  await a.engine.run();
  const localId = b.api.find('1').children[0].id;
  const getTree = b.api.getTree.bind(b.api);
  let captures = 0;
  b.api.getTree = async () => {
    if (++captures === 2) await b.api.removeTree(localId);
    return getTree();
  };
  await settle(b, a);
  assert.deepEqual(treeContents(b.api), treeContents(a.api));
  assert.equal(b.api.find('1').children.length, 0);
  assert.equal(b.api.find('2').children[0].title, '远端新增');
  assert.equal((await b.engine.summary()).deletedCount, 1);
});

for (const container of ['toolbar', 'folder', 'account']) {
  test(`应用远端标题时保留${container}中新调整的顺序`, async () => {
    const shared = new MemoryExchange();
    const a = participant(shared), b = participant(shared, 'Edge');
    if (container === 'account') {
      b.api.find('1').syncing = false;
      b.api.tree[0].children.push({ id: '7', parentId: '0', title: '账号收藏栏', folderType: 'bookmarks-bar', syncing: true, children: [] });
    }
    const parentId = container === 'folder' ? (await a.api.create({ parentId: '1', title: '资料' })).id : '1';
    for (const title of ['A', 'B', 'C']) {
      await a.api.create({ parentId, title, url: `https://late-order.example/${title}` });
    }
    await start(a); await start(b); await settle(a, b);
    await a.api.update(a.api.find(parentId).children[0].id, { title: 'A · 对端修改' });
    await a.engine.run();
    let localParentId = '1';
    if (container === 'folder') localParentId = b.api.find('1').children[0].id;
    if (container === 'account') localParentId = '7';
    const get = b.api.get.bind(b.api);
    let reordered = false;
    b.api.get = async id => {
      if (!reordered) {
        reordered = true;
        await b.api.move(b.api.find(localParentId).children[2].id, { parentId: localParentId, index: 0 });
      }
      return get(id);
    };
    await settle(b, a);
    const expected = ['C', 'A · 对端修改', 'B'];
    assert.deepEqual(b.api.find(localParentId).children.map(node => node.title), expected);
    assert.deepEqual(a.api.find(parentId).children.map(node => node.title), expected);
  });
}

test('远端和应用开始前的本地同时排序，保留较晚的本地顺序', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  for (const title of ['A', 'B', 'C']) await a.api.create({ parentId: '1', title, url: `https://late-order.example/${title}` });
  await start(a); await start(b); await settle(a, b);
  await a.api.move(a.api.find('1').children[1].id, { parentId: '1', index: 0 });
  await a.engine.run();
  const getTree = b.api.getTree.bind(b.api);
  let captures = 0;
  b.api.getTree = async () => {
    if (++captures === 2) await b.api.move(b.api.find('1').children[2].id, { parentId: '1', index: 0 });
    return getTree();
  };
  await settle(b, a);
  assert.deepEqual(b.api.find('1').children.map(node => node.title), ['C', 'A', 'B']);
  assert.deepEqual(treeContents(b.api), treeContents(a.api));
});
