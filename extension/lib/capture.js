import { ROOTS, changeFields, digest, materialize, stableStringify, values } from './model.js';

function signature(parent, kind, title, url) {
  return JSON.stringify([parent, kind, title, url]);
}

export async function captureLocal(state, snapshot, now = Date.now()) {
  const previous = state.observed;
  const pending = state.pendingApply;
  const bindings = {};
  const occupied = new Set(ROOTS);
  const local = {};
  const initial = previous === null;
  const empty = Object.keys(state.records).length === 0;
  const candidates = new Map();
  for (const [id, record] of Object.entries(state.records)) {
    if (ROOTS.includes(id)) continue;
    const node = values(record);
    const key = signature(node.parent, node.kind, node.title, node.url);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(id);
  }
  for (const ids of candidates.values()) ids.sort();
  const occurrences = new Map();

  async function visit(raw, parent, rootNativeId) {
    let id = raw.root || state.bindings[raw.id];
    if (id && !ROOTS.includes(id)) {
      const old = previous?.[id];
      const record = state.records[id];
      const recycledId = old?.nativeId === raw.id && old.dateAdded > 0 && raw.dateAdded > 0 &&
        old.dateAdded !== raw.dateAdded && (old.title !== raw.title || old.url !== raw.url);
      if (record?.kind.value !== raw.kind || recycledId) id = null;
    }
    if (id && occupied.has(id) && !ROOTS.includes(id)) id = null;
    if (!id) {
      const key = signature(parent, raw.kind, raw.title, raw.url);
      const candidate = (candidates.get(key) || []).find(item => {
        if (occupied.has(item)) return false;
        const record = state.records[item];
        return !record.deleted.value || (raw.dateAdded > 0 && raw.dateAdded <= record.deleted.stamp.time);
      });
      if (candidate) id = candidate;
      if (!id && initial && empty) {
        const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        id = await digest([key, occurrence]);
      }
      id ||= crypto.randomUUID();
    }
    if (!raw.root) occupied.add(id);
    bindings[raw.id] = id;
    const children = [];
    for (const child of raw.children) children.push(await visit(child, id, rootNativeId));
    if (ROOTS.includes(id)) {
      const root = local[id] ||= { nativeIds: [], virtualNativeIds: [], kind: 'folder', children: [] };
      root.nativeIds.push(raw.id);
      if (raw.virtual) root.virtualNativeIds.push(raw.id);
      root.children.push(...children);
      return id;
    }
    local[id] = {
      nativeId: raw.id, rootNativeId, dateAdded: raw.dateAdded, kind: raw.kind, title: raw.title, url: raw.url,
      parent, children,
    };
    return id;
  }

  for (const root of snapshot.roots) await visit(root, root.root, root.id);
  // A disappearing cloud/account root is not evidence that its children were deleted.
  const availableRoots = new Set(snapshot.roots.map(root => root.id));
  const previousVirtualRoots = new Set(ROOTS.flatMap(id => previous?.[id]?.virtualNativeIds || []));
  const held = new Set();
  if (previous) {
    for (const [id, node] of Object.entries(previous)) {
      if (!ROOTS.includes(id) && !local[id] && !availableRoots.has(node.rootNativeId) && !previousVirtualRoots.has(node.rootNativeId)) {
        local[id] = node;
        bindings[node.nativeId] = id;
        held.add(id);
      }
    }
  }
  // Retain unavailable account roots' ordering as well as their nodes. Fill
  // the available slots with the actual visible order, preserving local edits.
  for (const role of ROOTS) {
    const heldChildren = new Set([...held].filter(id => local[id].parent === role));
    if (!heldChildren.size) continue;
    const root = local[role] ||= { nativeIds: [], virtualNativeIds: [], kind: 'folder', children: [] };
    const visible = root.children;
    const present = new Set(visible);
    let index = 0;
    root.children = (state.records[role]?.children?.value || []).flatMap(id =>
      heldChildren.has(id) ? [id] : present.has(id) ? [visible[index++]] : []);
    root.children.push(...visible.slice(index));
  }
  const expected = pending ? materialize({ records: pending.records }) : null;
  for (const [id, node] of Object.entries(local)) {
    if (ROOTS.includes(id)) {
      const old = previous?.[id];
      if (!state.records[id]?.children || (old && !equal(old.children, node.children) &&
        !matchesAppliedOrder(id, node.children, expected))) changeFields(state, id, { children: node.children }, now);
      continue;
    }
    const record = state.records[id];
    const old = previous?.[id];
    if (!record) {
      changeFields(state, id, {
        kind: node.kind, title: node.title, url: node.url, parent: node.parent,
        children: node.children, deleted: false,
      }, now);
      continue;
    }
    // Newly rebound IDs after cloud sync/restart already describe an existing record.
    // Only observed changes are edits; imported target values are acknowledgements.
    if (!old) continue;
    const updates = {};
    for (const field of ['title', 'url', 'parent']) {
      if (!equal(old[field], node[field]) && !equal(expected?.nodes[id]?.[field], node[field])) updates[field] = node[field];
    }
    if (node.kind === 'folder' && !equal(old.children, node.children) &&
      !matchesAppliedOrder(id, node.children, expected)) updates.children = node.children;
    changeFields(state, id, updates, now);
  }
  if (previous) {
    for (const [id, old] of Object.entries(previous)) {
      if (ROOTS.includes(id) || local[id] || !state.records[id]) continue;
      // Deletions executed by an interrupted apply are not a new local operation.
      if (!expected || expected.nodes[id]) changeFields(state, id, { deleted: true }, now);
    }
  }
  state.bindings = bindings;
  state.observed = local;
  return local;
}

function matchesAppliedOrder(id, children, expected) {
  if (!expected) return false;
  const desired = expected.children[id] || [];
  const present = new Set(children);
  return children.every(child => desired.includes(child)) && equal(children, desired.filter(child => present.has(child)));
}

function equal(a, b) {
  return stableStringify(a) === stableStringify(b);
}
