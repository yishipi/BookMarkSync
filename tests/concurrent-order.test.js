import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryExchange, participant, start, settle } from './helpers.js';
import { changeFields, freshState, makeDocument, mergeDocument, validateDocument } from '../extension/lib/model.js';

const toolbar = 'root:toolbar';
const add = (peer, title, index) => peer.api.create({ parentId: '1', title, index, url: 'https://insert.example/' + title });
const titles = peer => peer.api.find('1').children.map(item => item.title);

for (const firstPublisher of ['Chrome', 'Edge']) {
  test(firstPublisher + ' 先发布，离线端重入后保留同一间隙里的两批插入及后续拖动', async () => {
    const shared = new MemoryExchange();
    const chrome = participant(shared), edge = participant(shared, 'Edge');
    for (const [peer, actor] of [[chrome, 'actor-chrome'], [edge, 'actor-edge']]) {
      await peer.store.set('state', freshState(actor));
    }
    await add(chrome, 'A'); await add(chrome, 'B');
    await start(chrome); await start(edge); await settle(chrome, edge);
    const [first, offline] = firstPublisher === 'Chrome' ? [chrome, edge] : [edge, chrome];
    await offline.engine.setEnabled(false);
    await add(chrome, 'X', 1); await add(chrome, 'X2', 2);
    await add(edge, 'Y', 1); await add(edge, 'Y2', 2);
    await first.engine.run(); await offline.engine.setEnabled(true); await settle(offline, first);
    const expected = ['A', 'X', 'X2', 'Y', 'Y2', 'B'];
    assert.deepEqual(titles(chrome), expected);
    assert.deepEqual(titles(edge), expected);
    const writes = shared.writes, backups = shared.backups.length;
    await settle(chrome, edge);
    assert.equal(shared.writes, writes); assert.equal(shared.backups.length, backups);
    await edge.api.move(edge.api.find('1').children.at(-1).id, { parentId: '1', index: 0 });
    await settle(edge, chrome);
    assert.deepEqual(titles(chrome), ['B', ...expected.slice(0, -1)]);
    assert.deepEqual(titles(chrome), titles(edge));
    assert.equal((await chrome.engine.load()).records[toolbar].children.versions, undefined);
  });
}

test('并发插入时相邻项被移动或删除，顺序记录不会把它们带回原目录', async () => {
  const shared = new MemoryExchange();
  const a = participant(shared), b = participant(shared, 'Edge');
  for (const title of ['A', 'B', 'C']) await add(a, title);
  await start(a); await start(b); await settle(a, b);
  await add(a, 'X', 1);
  const [moved, deleted] = b.api.find('1').children;
  await b.api.move(moved.id, { parentId: '2' }); await b.api.remove(deleted.id);
  await settle(a, b);
  for (const side of [a, b]) {
    assert.deepEqual(titles(side), ['X', 'C']);
    assert.deepEqual(side.api.find('2').children.map(item => item.title), ['A']);
    assert.equal((await side.engine.summary()).deletedCount, 1);
  }
});

// Build ordinary schema-1 snapshots with no new metadata. Each publisher has
// seen the common starting order but has not seen either of the other edits.
function orderSnapshots() {
  const base = freshState('actor-origin');
  base.config.workspace = { id: 'workspace-test' };
  changeFields(base, toolbar, { children: ['bookmark-A', 'bookmark-B'] }, 1);
  return ['X', 'Y', 'Z'].map((suffix, index) => {
    const state = structuredClone(base);
    state.actor = 'participant-' + suffix;
    changeFields(state, toolbar, { children: ['bookmark-A', 'bookmark-' + suffix, 'bookmark-B'] }, 10 - index);
    return makeDocument(state);
  });
}

test('三份旧格式排序按任意到达顺序合并，读回中间副本或重放旧版本结果一致', () => {
  const docs = orderSnapshots();
  let canonical;
  for (const [i, j, k] of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const partial = freshState('actor-gateway');
    partial.config.workspace = { id: docs[0].workspace };
    mergeDocument(partial, docs[i]); mergeDocument(partial, docs[j]);
    const wire = JSON.parse(JSON.stringify(makeDocument(partial)));
    const state = freshState('actor-reader');
    mergeDocument(state, docs[k]); mergeDocument(state, validateDocument(wire, wire.workspace));
    for (const doc of docs) mergeDocument(state, doc);
    const order = state.records[toolbar].children;
    assert.deepEqual(order.value, ['bookmark-A', 'bookmark-X', 'bookmark-Y', 'bookmark-Z', 'bookmark-B']);
    if (canonical) assert.deepEqual(order, canonical);
    canonical = order;
  }
});

test('两端插入时还拖动了其他条目，拖动按版本决定，间隙内的插入次序保持固定', () => {
  const [first, second] = orderSnapshots();
  first.records[toolbar].children.value = ['bookmark-A', 'bookmark-X', 'bookmark-B', 'bookmark-C'];
  second.records[toolbar].children.value = ['bookmark-C', 'bookmark-A', 'bookmark-Y', 'bookmark-B'];
  const gap = ['bookmark-A', 'bookmark-X', 'bookmark-Y', 'bookmark-B'];
  for (const [time, expected] of [[12, ['bookmark-C', ...gap]], [8, [...gap, 'bookmark-C']]]) {
    second.records[toolbar].children.stamp.time = time;
    const state = freshState('actor-reader');
    mergeDocument(state, first); mergeDocument(state, second);
    assert.deepEqual(state.records[toolbar].children.value, expected);
  }
});

test('两端合并后的新排序取代旧版本，仍能与离线第三端的插入合并', () => {
  const [x, y, z] = orderSnapshots();
  const local = freshState('actor-local');
  local.config.workspace = { id: x.workspace };
  mergeDocument(local, x); mergeDocument(local, y);
  changeFields(local, toolbar, { children: ['bookmark-L', 'bookmark-A', 'bookmark-Y', 'bookmark-X', 'bookmark-B'] }, 20);
  mergeDocument(local, z);
  const order = local.records[toolbar].children;
  assert.deepEqual(order.versions.map(v => v.stamp.actor), ['actor-local', 'participant-Z']);
  assert.deepEqual(order.value, ['bookmark-L', 'bookmark-A', 'bookmark-Y', 'bookmark-X', 'bookmark-Z', 'bookmark-B']);
  mergeDocument(local, y); mergeDocument(local, x);
  assert.deepEqual(local.records[toolbar].children, order);
});

test('拒绝与排序来源不符、嵌套或重复的排序版本', () => {
  const state = freshState('actor-reader');
  const [x, y] = orderSnapshots();
  state.config.workspace = { id: x.workspace };
  mergeDocument(state, x); mergeDocument(state, y);
  const doc = makeDocument(state);
  for (const corrupt of [
    r => r.value.reverse(),
    r => r.versions.push(r.versions[0]),
    r => { r.versions[0].versions = []; },
    r => { r.versions[0].value = [null]; },
    r => { r.versions[0].seen[r.versions[1].stamp.actor] = r.versions[1].stamp.seq; },
  ]) {
    const invalid = structuredClone(doc);
    corrupt(invalid.records[toolbar].children);
    assert.throws(() => validateDocument(invalid, doc.workspace), /排序/);
  }
});
