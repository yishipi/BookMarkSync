import { ROOTS, changeFields, digest, materialize, values } from './model.js';
import { childrenInFolder, mergeChildOrder, sameOrder, sameRelativeOrder } from './sibling-order.js';

function signature(parent, kind, title, url) {
  return JSON.stringify([parent, kind, title, url]);
}

// Preserve valid browser identities and record changes outside the current replay.
export async function captureLocal(state, snapshot, now = Date.now()) {
  const previous = state.observed;
  const pending = state.pendingApply;
  const bindings = {};
  const occupied = new Set(ROOTS);
  const local = {};
  const initial = previous === null;
  const empty = Object.keys(state.records).length === 0;
  const initialOrder = initial && !empty ? materialize(state).children : null;
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

  // A new duplicate may appear before its still-bound original in the tree.
  // Reserve all valid native bindings before matching any item by content.
  const reserved = new Map();
  const remaining = [...snapshot.roots];
  while (remaining.length) {
    const raw = remaining.pop();
    for (const child of raw.children) remaining.push(child);
    if (raw.root) continue;
    const id = state.bindings[raw.id];
    if (!id || occupied.has(id)) continue;
    const old = previous?.[id];
    const recycledId = old?.nativeId === raw.id && old.dateAdded > 0 && raw.dateAdded > 0 &&
      old.dateAdded !== raw.dateAdded && (old.title !== raw.title || old.url !== raw.url);
    if (state.records[id]?.kind.value !== raw.kind || recycledId) continue;
    reserved.set(raw.id, id);
    occupied.add(id);
  }

  async function visit(raw, parent, rootNativeId) {
    let id = raw.root || reserved.get(raw.id);
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
      occupied.add(id);
    }
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
  function captureChildren(id, node, old) {
    const savedOrder = state.records[id]?.children?.value;
    if (!savedOrder) return node.children;
    // Keep the shared order for existing entries and place new local entries
    // using their observed neighbors (also when the shared folder was empty).
    if (initialOrder) {
      let order = initialOrder[id] || savedOrder;
      for (const nativeId of node.nativeIds || [node.nativeId]) {
        order = mergeChildOrder(order, childrenInFolder(local, id, nativeId));
      }
      return order;
    }
    if (!old) return undefined;
    return captureFolderOrder(id, local, previous, savedOrder, expected?.children[id] || [], pending);
  }

  for (const [id, node] of Object.entries(local)) {
    const old = previous?.[id];
    if (ROOTS.includes(id)) {
      const children = captureChildren(id, node, old);
      if (children) changeFields(state, id, { children }, now);
      continue;
    }
    const record = state.records[id];
    if (!record) {
      changeFields(state, id, {
        kind: node.kind, title: node.title, url: node.url, parent: node.parent,
        children: node.children, deleted: false,
      }, now);
      continue;
    }
    const updates = {};
    // Rebound IDs already describe existing records. Only observed changes
    // outside the applied target are new title, URL or parent edits.
    if (old) {
      for (const field of ['title', 'url', 'parent']) {
        if (old[field] !== node[field] && expected?.nodes[id]?.[field] !== node[field]) updates[field] = node[field];
      }
    }
    if (node.kind === 'folder') {
      const children = captureChildren(id, node, old);
      if (children) updates.children = children;
    }
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

// Update only the slots a changed physical folder can observe. The order in
// which the browser happens to enumerate its local/account roots is irrelevant.
function captureFolderOrder(id, local, previous, savedOrder, desired, pending) {
  const node = local[id];
  let order;
  for (const nativeId of node.nativeIds || [node.nativeId]) {
    const children = childrenInFolder(local, id, nativeId);
    const prior = childrenInFolder(previous, id, nativeId);
    if (sameOrder(children, prior)) continue;
    // An ordinary folder exposes its entire local order in one list.
    if (!pending && !node.nativeIds) return children;
    order ??= pending ? mergeChildOrder(savedOrder, desired) : savedOrder;
    const replayed = pending && matchesApplyOrder(children, prior, desired, local, nativeId, pending);
    order = mergeChildOrder(order, children, !replayed);
  }
  if (!order || pending) return order;
  const present = new Set(node.children);
  const departed = new Set(previous[id].children.filter(child => !present.has(child)));
  return order.filter(child => !departed.has(child));
}

// Recognize the target, either side of the last native move, or appends that
// precede the first reorder. A distinguishable user sort wins over replay.
function matchesApplyOrder(children, prior, desired, local, nativeId, pending) {
  if (sameRelativeOrder(children, desired)) return true;
  const checkpoint = pending.reorders?.[nativeId];
  if (checkpoint) {
    const nativeOrder = children.map(child => local[child].nativeId);
    return sameRelativeOrder(nativeOrder, checkpoint.after) ||
      (checkpoint.before && sameRelativeOrder(nativeOrder, checkpoint.before));
  }
  const priorIds = new Set(prior);
  const desiredIds = new Set(desired);
  const appended = children.filter(child => desiredIds.has(child) && !priorIds.has(child));
  const created = pending.createdChildren?.[nativeId];
  return sameRelativeOrder(children, prior.concat(appended)) &&
    (!created || sameRelativeOrder(appended, created));
}
