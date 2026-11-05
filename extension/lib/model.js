export const SCHEMA = 1;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ROOTS = ['root:toolbar', 'root:other', 'root:mobile'];
export const FIELDS = ['kind', 'title', 'url', 'parent', 'children', 'deleted'];
const ID = /^(?:root:(?:toolbar|other|mobile)|[a-zA-Z0-9_-]{8,100})$/;
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

export function freshState(actor = crypto.randomUUID()) {
  return {
    schema: SCHEMA, actor, clock: { time: 0, tick: 0 }, vector: {}, records: {},
    bindings: {}, observed: null, pendingApply: null, conflicts: [], resolvedConflicts: [], publishedHash: '',
    config: { enabled: false, intervalSeconds: 30, label: '', workspace: null },
    status: { phase: 'setup', message: '请选择两端共同使用的本地目录。', lastSync: null },
  };
}

export function stableStringify(value) {
  return JSON.stringify(value, function (_key, item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    typeof value === 'string' ? value : stableStringify(value),
  ));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function compareStamp(a, b) {
  return a.time - b.time || a.tick - b.tick || compareText(a.actor, b.actor) || a.seq - b.seq;
}

// Never use the browser UI locale to order replicated identifiers.
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function nextRegister(state, value, now) {
  const time = Math.max(now, state.clock.time);
  const tick = time === state.clock.time ? state.clock.tick + 1 : 0;
  const seq = (state.vector[state.actor] || 0) + 1;
  const seen = { ...state.vector };
  state.clock = { time, tick };
  state.vector[state.actor] = seq;
  return { value: structuredClone(value), stamp: { time, tick, actor: state.actor, seq }, seen };
}

export function changeFields(state, id, values, now = Date.now()) {
  const record = state.records[id] ||= {};
  for (const [field, value] of Object.entries(values)) {
    if (stableStringify(record[field]?.value) === stableStringify(value)) continue;
    record[field] = nextRegister(state, value, now);
  }
}

export function values(record) {
  return Object.fromEntries(Object.entries(record).map(([key, register]) => [key, register.value]));
}

function concurrent(a, b) {
  return a.stamp.actor !== b.stamp.actor &&
    (a.seen[b.stamp.actor] || 0) < b.stamp.seq &&
    (b.seen[a.stamp.actor] || 0) < a.stamp.seq;
}

export function mergeDocument(state, document) {
  state.resolvedConflicts = [...new Set([...(state.resolvedConflicts || []), ...(document.resolvedConflicts || [])])].sort();
  for (const conflict of document.conflicts || []) {
    if (!state.conflicts.some(item => item.key === conflict.key)) state.conflicts.push(structuredClone(conflict));
  }
  for (const [actor, seq] of Object.entries(document.vector)) {
    state.vector[actor] = Math.max(state.vector[actor] || 0, seq);
  }
  for (const [id, incoming] of Object.entries(document.records)) {
    const current = state.records[id] ||= {};
    for (const [field, candidate] of Object.entries(incoming)) {
      const previous = current[field];
      if (!previous) {
        current[field] = structuredClone(candidate);
      } else if (compareStamp(previous.stamp, candidate.stamp) !== 0) {
        const winner = compareStamp(previous.stamp, candidate.stamp) > 0 ? previous : candidate;
        const loser = winner === previous ? candidate : previous;
        if (concurrent(previous, candidate) && stableStringify(previous.value) !== stableStringify(candidate.value)
          && ['title', 'url', 'parent', 'deleted'].includes(field)) {
          const key = `${id}:${field}:${loser.stamp.actor}:${loser.stamp.seq}`;
          if (!state.conflicts.some(conflict => conflict.key === key)) {
            state.conflicts.push({ key, id, field, loser: structuredClone(loser), winner: structuredClone(winner) });
          }
        }
        current[field] = structuredClone(winner);
      }
      const stamp = candidate.stamp;
      if (stamp.time > state.clock.time || (stamp.time === state.clock.time && stamp.tick > state.clock.tick)) {
        state.clock = { time: stamp.time, tick: stamp.tick };
      }
    }
  }
  state.conflicts = state.conflicts.filter(item => !state.resolvedConflicts.includes(item.key))
    .sort((a, b) => compareStamp(b.loser.stamp, a.loser.stamp) || compareText(a.key, b.key)).slice(0, 200);
}

export function makeDocument(state) {
  return {
    schema: SCHEMA, workspace: state.config.workspace.id, writer: state.actor,
    label: state.config.label, vector: state.vector, records: state.records, conflicts: state.conflicts,
    resolvedConflicts: state.resolvedConflicts || [],
  };
}

export function validateDocument(document, workspace, nested = false) {
  if (!document || document.schema !== SCHEMA || document.workspace !== workspace ||
    !validId(document.writer) || ROOTS.includes(document.writer) || typeof document.label !== 'string' || document.label.length > 80 ||
    !plainObject(document.vector) || !plainObject(document.records)) {
    throw new Error('交换文件格式或工作区不匹配，已保留本地书签。');
  }
  if (Object.keys(document.records).length > 100000) throw new Error('交换文件的书签数量超过限制。');
  for (const [actor, seq] of Object.entries(document.vector)) {
    if (!validId(actor) || ROOTS.includes(actor) || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('交换文件版本信息无效。');
    }
  }
  for (const [id, record] of Object.entries(document.records)) {
    if (!validId(id) || !plainObject(record)) throw new Error('交换文件包含无效书签。');
    const isRoot = ROOTS.includes(id);
    if (!isRoot && FIELDS.some(field => !Object.hasOwn(record, field))) throw new Error('交换文件书签字段不完整。');
    for (const [field, register] of Object.entries(record)) {
      if (!FIELDS.includes(field) || !plainObject(register) || !plainObject(register.stamp) || !plainObject(register.seen)) {
        throw new Error('交换文件字段格式无效。');
      }
      const stamp = register.stamp;
      if (!Number.isSafeInteger(stamp.time) || stamp.time < 0 || stamp.time > Date.now() + 86400000 ||
        !Number.isSafeInteger(stamp.tick) || stamp.tick < 0 || !Number.isSafeInteger(stamp.seq) || stamp.seq < 1 ||
        !Object.hasOwn(document.vector, stamp.actor) || document.vector[stamp.actor] < stamp.seq) {
        throw new Error('交换文件包含无效时间或版本。');
      }
      for (const [actor, seq] of Object.entries(register.seen)) {
        if (!Object.hasOwn(document.vector, actor) || !Number.isSafeInteger(seq) || seq < 0 || seq > document.vector[actor]) {
          throw new Error('交换文件因果版本无效。');
        }
      }
      const value = register.value;
      if ((field === 'kind' && !['bookmark', 'folder'].includes(value)) ||
        (field === 'title' && (typeof value !== 'string' || value.length > 100000)) ||
        (field === 'url' && value !== null && (typeof value !== 'string' || value.length > 200000)) ||
        (field === 'parent' && !validId(value)) || (field === 'deleted' && typeof value !== 'boolean') ||
        (field === 'children' && (!Array.isArray(value) || value.some(child => !validId(child)) || new Set(value).size !== value.length))) {
        throw new Error('交换文件书签内容无效。');
      }
      if (isRoot && field !== 'children') throw new Error('不能修改浏览器特殊根文件夹。');
    }
    if (!isRoot && ((record.kind.value === 'folder') !== (record.url.value === null))) {
      throw new Error('交换文件书签类型与网址不匹配。');
    }
  }
  if (document.conflicts !== undefined) {
    if (!Array.isArray(document.conflicts) || document.conflicts.length > 200) throw new Error('恢复记录格式无效。');
    for (const conflict of document.conflicts) {
      if (!validId(conflict?.id) || typeof conflict.key !== 'string' || conflict.key.length > 400 ||
        !['title', 'url', 'parent', 'deleted'].includes(conflict.field) || !conflict.loser || !conflict.winner) {
        throw new Error('恢复记录内容无效。');
      }
      // Reuse the same register validator at this external boundary.
      validateDocument({ ...document, conflicts: undefined,
        records: { 'root:other': {}, [conflict.id]: { ...document.records[conflict.id], [conflict.field]: conflict.loser } } }, workspace, true);
      validateDocument({ ...document, conflicts: undefined,
        records: { [conflict.id]: { ...document.records[conflict.id], [conflict.field]: conflict.winner } } }, workspace, true);
    }
  }
  if (document.resolvedConflicts !== undefined && (!Array.isArray(document.resolvedConflicts) ||
    document.resolvedConflicts.length > 10000 || document.resolvedConflicts.some(key => typeof key !== 'string' || key.length > 400))) {
    throw new Error('恢复确认记录无效。');
  }
  if (!nested && new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_FILE_BYTES) {
    throw new Error('合并后的交换数据超过 20 MiB，已暂停应用，请减少同步数据或导出备份后整理。');
  }
  return document;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function materialize(state) {
  const nodes = {};
  for (const [id, record] of Object.entries(state.records)) {
    if (ROOTS.includes(id)) continue;
    const node = values(record);
    if (!node.deleted) nodes[id] = { ...node, id };
  }
  const repairs = [];
  for (const node of Object.values(nodes)) {
    if (!ROOTS.includes(node.parent) && nodes[node.parent]?.kind !== 'folder') {
      repairs.push({ id: node.id, reason: '原文件夹已删除或不可用，已放入其他收藏夹。' });
      node.parent = 'root:other';
    }
  }
  // Concurrent moves can create a cycle even though each browser rejected local cycles.
  const done = new Set();
  for (const start of Object.keys(nodes).sort()) {
    const path = [];
    const positions = new Map();
    let id = start;
    while (nodes[id] && !done.has(id)) {
      if (positions.has(id)) {
        const broken = path.slice(positions.get(id)).sort().at(-1);
        nodes[broken].parent = 'root:other';
        repairs.push({ id: broken, reason: '两端移动形成文件夹循环，已放入其他收藏夹。' });
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = nodes[id].parent;
    }
    path.forEach(item => done.add(item));
  }
  const children = Object.fromEntries([...ROOTS, ...Object.keys(nodes)].map(id => [id, []]));
  for (const node of Object.values(nodes)) children[node.parent].push(node.id);
  for (const [parent, ids] of Object.entries(children)) {
    const order = state.records[parent]?.children?.value || [];
    const ranks = new Map(order.map((id, index) => [id, index]));
    ids.sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity) || compareText(a, b));
  }
  return { nodes, children, repairs };
}

export function restoreRecord(state, id, conflictKey) {
  if (!validId(id) || ROOTS.includes(id) || !Object.hasOwn(state.records, id)) throw new Error('没有可恢复的书签。');
  const record = state.records[id];
  if (conflictKey) {
    const conflict = state.conflicts.find(item => item.key === conflictKey && item.id === id);
    if (!conflict) throw new Error('恢复记录不存在。');
    changeFields(state, id, { [conflict.field]: conflict.loser.value, deleted: false });
    state.resolvedConflicts ||= [];
    state.resolvedConflicts.push(conflictKey);
    state.conflicts = state.conflicts.filter(item => item.key !== conflictKey);
    return;
  }
  const deletion = record.deleted;
  changeFields(state, id, { deleted: false });
  if (record.kind.value !== 'folder') return;
  const descendants = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    for (const [childId, child] of Object.entries(state.records)) {
      if (ROOTS.includes(childId) || descendants.has(childId) || !descendants.has(child.parent.value)) continue;
      descendants.add(childId);
      added = true;
    }
  }
  for (const childId of descendants) {
    if (childId === id) continue;
    const child = state.records[childId];
    if (child.deleted.value && child.deleted.stamp.actor === deletion.stamp.actor &&
      child.deleted.stamp.time === deletion.stamp.time) changeFields(state, childId, { deleted: false });
  }
}
