import { captureLocal } from './capture.js';
import { ROOTS, digest, freshState, makeDocument, materialize, mergeDocument, restoreRecord, validateDocument, values } from './model.js';

export class SyncEngine {
  constructor({ store, bookmarks, exchange, label }) {
    this.store = store;
    this.bookmarks = bookmarks;
    this.exchangeFactory = exchange;
    this.label = label;
  }

  async load() {
    const saved = await this.store.get('state');
    if (saved && saved.schema !== 1) throw new Error('本地状态版本较新，请更新扩展。');
    return saved || freshState();
  }

  async save(state) { await this.store.set('state', state); }

  async configure({ label, intervalSeconds, directoryKey } = {}) {
    if (directoryKey !== undefined && (typeof directoryKey !== 'string' || !/^selection:[a-f0-9-]{36}$/.test(directoryKey))) {
      throw new Error('目录选择已失效，请重新选择。');
    }
    const handle = await this.store.get(directoryKey || 'directory');
    if (!handle) throw new Error('请先选择共享目录。');
    const exchange = this.exchangeFactory(handle);
    await exchange.checkPermission();
    const workspace = await exchange.workspace({ create: true });
    validateSources(await exchange.documents(), workspace.id);
    let state = await this.load();
    const oldHandle = await this.store.get('directory');
    const sameDirectory = !directoryKey || (oldHandle && handle.isSameEntry && await handle.isSameEntry(oldHandle));
    const keepEnabled = Boolean(sameDirectory && state.config.workspace?.id === workspace.id && state.config.enabled);
    if (state.config.workspace && state.config.workspace.id !== workspace.id) state = freshState();
    state.config = {
      ...state.config, enabled: keepEnabled, workspace, label: (label || this.label).slice(0, 80),
      intervalSeconds: [30, 60, 120, 300].includes(intervalSeconds) ? intervalSeconds : 30,
      directoryName: handle.name,
    };
    // Commit the selected handle and its matching workspace together. A failed
    // selection must not replace the directory used by an already running sync.
    await this.store.setMany([['directory', handle], ['state', state]]);
    return this.run({ preview: !keepEnabled, reason: '连接目录' });
  }

  async permissionRestored() {
    const state = await this.load();
    return this.run({ preview: !state.config.enabled, reason: '恢复目录授权' });
  }

  async setEnabled(enabled) {
    const state = await this.load();
    state.config.enabled = Boolean(enabled);
    state.status = { ...state.status, phase: enabled ? 'ready' : 'paused', message: enabled ? '自动同步已启用。' : '自动同步已暂停，现有书签保持不变。' };
    await this.save(state);
    return enabled ? this.run({ reason: '开始同步' }) : summary(state);
  }

  async restore(id, conflictKey) {
    const state = await this.load();
    restoreRecord(state, id, conflictKey);
    await this.save(state);
    return this.run({ force: true, reason: '恢复书签' });
  }

  async run({ preview = false, force = false, reason = '自动同步' } = {}) {
    let state = await this.load();
    if (!state.config.workspace || (!state.config.enabled && !preview && !force)) return summary(state);
    try {
      const handle = await this.store.get('directory');
      if (!handle) throw Object.assign(new Error('共享目录记录不存在，请重新选择目录。'), { code: 'permission' });
      const exchange = this.exchangeFactory(handle);
      // Preserve local edits even while directory access is unavailable.
      const before = await this.bookmarks.read(state.bindings);
      if (state.observed) {
        await captureLocal(state, before);
        await this.save(state);
      }
      await exchange.checkPermission();
      const workspace = await exchange.workspace();
      if (workspace.id !== state.config.workspace.id) throw new Error('共享目录的工作区标识已更改，请重新连接，避免混用书签。');
      const sources = await exchange.documents();
      // Validate all files before applying any of them.
      validateSources(sources, workspace.id);
      for (const source of sources) mergeDocument(state, source.document);
      if (!state.observed) await captureLocal(state, before);
      // A union can exceed the limit even when each input file fits. Check it
      // before changing the browser, so the result can always be published.
      try { validateDocument(makeDocument(state), workspace.id); }
      catch (error) { state = await this.load(); throw error; }
      state.status.peers = sources.filter(source => source.document.writer !== state.actor).map(source => ({
        label: source.document.label, actor: source.document.writer, modified: source.modified,
      }));
      const target = materialize(state);
      const plan = await this.bookmarks.plan(state, target);
      state.status.plan = plan;
      state.status.ignored = before.ignored;
      state.status.repairs = target.repairs;
      if (preview) {
        state.status.phase = 'preview';
        state.status.message = state.status.lastSync
          ? '合并预览已更新，尚未应用。可点击“恢复自动同步”或“立即同步”。'
          : '目录已连接。首次同步将合并两端现有书签，点击“开始自动同步”应用。';
        await this.save(state);
        return summary(state);
      }
      if (plan.total) {
        await exchange.backup(state.actor, before.tree);
        state.pendingApply = { records: structuredClone(state.records) };
        await this.save(state);
        const after = await this.bookmarks.apply(state, target, () => this.save(state));
        await captureLocal(state, after);
      }
      state.pendingApply = null;
      const document = makeDocument(state);
      validateDocument(document, workspace.id);
      const hash = await digest(document);
      if (hash !== state.publishedHash || !sources.some(source => source.document.writer === state.actor)) {
        await exchange.write(`replica-${state.actor}.json`, document);
        state.publishedHash = hash;
      }
      state.status.phase = state.config.enabled ? 'ready' : 'paused';
      state.status.message = state.config.enabled ? '已同步，后台自动检查中。' : '本次同步完成，自动同步仍暂停。';
      state.status.lastSync = Date.now();
      if (reason.includes('收藏夹管理器')) state.status.lastManagerSync = state.status.lastSync;
      state.status.reason = reason;
      state.status.error = null;
      await this.save(state);
      return summary(state);
    } catch (error) {
      state.status.phase = error.code === 'permission' || ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'permission' : 'error';
      state.status.message = state.status.phase === 'permission'
        ? '共享目录的读写授权不可用。请打开设置点击“恢复目录授权”；本地书签已保留。'
        : error.message || String(error);
      state.status.error = { name: error.name, message: state.status.message, at: Date.now() };
      await this.save(state);
      return summary(state);
    }
  }

  async summary() { return summary(await this.load()); }
}

function validateSources(sources, workspace) {
  for (const source of sources) {
    validateDocument(source.document, workspace);
    if (source.name !== `replica-${source.document.writer}.json`) throw new Error('交换文件名称与发布端标识不符，已暂停应用，请检查共享目录。');
  }
}

function summary(state) {
  const alive = Object.entries(state.records).filter(([id, record]) => !ROOTS.includes(id) && !record.deleted.value);
  const deleted = Object.entries(state.records).filter(([id, record]) => !ROOTS.includes(id) && record.deleted.value)
    .sort((a, b) => b[1].deleted.stamp.time - a[1].deleted.stamp.time)
    .map(([id, record]) => ({ id, ...values(record), at: record.deleted.stamp.time }));
  return {
    actor: state.actor, config: state.config, status: state.status,
    bookmarks: alive.filter(([, record]) => record.kind.value === 'bookmark').length,
    folders: alive.filter(([, record]) => record.kind.value === 'folder').length,
    deleted: deleted.slice(0, 100), deletedCount: deleted.length,
    conflicts: state.conflicts.map(conflict => ({ ...conflict, title: state.records[conflict.id]?.title?.value || '未命名' })),
  };
}
