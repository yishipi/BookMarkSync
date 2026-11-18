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

for (const scenario of ['toolbar', 'folder', 'account', 'local-edit', 'local-insert', 'local-delete', 'local-move']) {
  test(`排序应用中断后区分已执行的移动和用户排序（${scenario}）`, async () => {
    const shared = new MemoryExchange();
    const a = participant(shared), b = participant(shared, 'Edge');
    if (scenario === 'account') {
      b.api.find('1').syncing = false;
      b.api.tree[0].children.push({ id: '7', parentId: '0', title: '账号收藏栏', folderType: 'bookmarks-bar', syncing: true, children: [] });
    }
    const aParent = scenario === 'folder' ? (await a.api.create({ parentId: '1', title: '资料' })).id : '1';
    for (const title of ['A', 'B', 'C', 'D']) {
      await a.api.create({ parentId: aParent, title, url: `https://interrupted-order.example/${title}` });
    }
    await start(a); await start(b); await settle(a, b);
    const bParent = scenario === 'folder' ? b.api.find('1').children[0].id : scenario === 'account' ? '7' : '1';
    // Give the logical toolbar two physical roots in the account scenario.
    if (scenario === 'account') {
      const extra = await b.api.create({ parentId: '1', title: '本地项', url: 'https://interrupted-order.example/local' });
      await settle(b, a);
      assert.equal(b.api.find(extra.id).parentId, '1');
    }
    for (const title of ['B', 'C', 'D']) {
      const item = a.api.find(aParent).children.find(node => node.title === title);
      await a.api.move(item.id, { parentId: aParent, index: 0 });
    }
    const titles = (participant, id) => participant.api.find(id).children.map(node => node.title);
    const sourceOrder = titles(a, aParent);
    await a.engine.run();
    const move = b.api.move.bind(b.api);
    let moves = 0;
    let persisted;
    b.api.move = async (...args) => {
      // Exercise both sides of the crash window: a move may already have
      // reached the browser even if the worker did not receive its reply.
      if (++moves === 2 && scenario !== 'folder') throw new Error('模拟排序中断');
      const result = await move(...args);
      if (moves === 1 && scenario === 'folder') {
        persisted = await b.store.get('state');
        throw new Error('模拟排序中断');
      }
      return result;
    };
    assert.equal((await b.engine.run()).status.phase, 'error');
    b.api.move = move;
    // Restart from the last durable state, before the error handler ran.
    if (persisted) await b.store.set('state', persisted);
    assert.deepEqual(titles(b, bParent), ['D', 'A', 'B', 'C']);
    let expected = sourceOrder;
    if (scenario === 'local-edit') {
      const c = b.api.find(bParent).children.find(node => node.title === 'C');
      await b.api.move(c.id, { parentId: bParent, index: 0 });
      expected = ['C', 'D', 'A', 'B'];
    }
    if (scenario === 'local-insert') {
      await b.api.create({ parentId: bParent, index: 2, title: '新书签', url: 'https://interrupted-order.example/new' });
      expected = ['D', 'C', '新书签', 'B', 'A'];
    }
    if (scenario === 'local-delete') {
      await b.api.remove(b.api.find(bParent).children.find(node => node.title === 'A').id);
      expected = ['D', 'C', 'B'];
    }
    if (scenario === 'local-move') {
      await b.api.move(b.api.find(bParent).children.find(node => node.title === 'A').id, { parentId: '2' });
      expected = ['D', 'C', 'B'];
    }
    await settle(b, a);
    assert.deepEqual(titles(b, bParent), expected.filter(title => title !== '本地项'));
    assert.deepEqual(titles(a, aParent), expected);
    if (scenario === 'local-move') {
      assert.deepEqual(titles(a, '2'), ['A']);
      assert.deepEqual(titles(b, '2'), ['A']);
    }
    const writes = shared.writes;
    const backups = shared.backups.length;
    await settle(b, a);
    assert.equal(shared.writes, writes);
    assert.equal(shared.backups.length, backups);
  });
}

test('创建后重排前中断，恢复时把远端新书签移到指定位置', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  const folder = await a.api.create({ parentId: '1', title: '资料' });
  await a.api.create({ parentId: folder.id, title: '原书签', url: 'https://create-order.example/original' });
  await start(a); await start(b); await settle(a, b);
  const bFolder = b.api.find('1').children[0].id;
  await a.api.create({ parentId: folder.id, index: 0, title: '远端新书签', url: 'https://create-order.example/new' });
  await a.engine.run();
  const get = b.api.get.bind(b.api);
  b.api.get = async id => {
    if (b.api.find(id).title === '远端新书签') throw new Error('模拟新建检查点后的中断');
    return get(id);
  };
  assert.equal((await b.engine.run()).status.phase, 'error');
  b.api.get = get;
  await settle(b, a);
  const expected = ['远端新书签', '原书签'];
  assert.deepEqual(b.api.find(bFolder).children.map(item => item.title), expected);
  assert.deepEqual(a.api.find(folder.id).children.map(item => item.title), expected);
});

test('中断后手动交换两个远端新书签，保留用户的排序', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  await a.api.create({ parentId: '1', title: '旧书签', url: 'https://new-item-order.example/old' });
  await start(a); await start(b); await settle(a, b);
  for (const title of ['新书签一', '新书签二']) {
    await a.api.create({ parentId: '1', title, url: `https://new-item-order.example/${title}` });
  }
  await a.engine.run();
  const get = b.api.get.bind(b.api);
  b.api.get = async id => {
    if (b.api.find('1').children.length === 3) throw new Error('模拟两次新建后的中断');
    return get(id);
  };
  assert.equal((await b.engine.run()).status.phase, 'error');
  b.api.get = get;
  await b.api.move(b.api.find('1').children[2].id, { parentId: '1', index: 1 });
  const expected = treeContents(b.api);
  await settle(b, a);
  assert.deepEqual(treeContents(b.api), expected);
  assert.deepEqual(treeContents(a.api), expected);
});
