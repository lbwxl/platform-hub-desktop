const fs = require('node:fs');
const path = require('node:path');

// Account keys are the platform shop_id. During the first login the backend
// Shop.id is used as the temporary key until the seller shop_id is discovered.
const SHOP_ID_PATTERN = /^\d+$/;

class JsonAccountRepository {
  constructor({ filePath, fsModule = fs } = {}) {
    if (!filePath) throw new TypeError('JsonAccountRepository 需要 filePath');
    this.filePath = filePath;
    this.fs = fsModule;
    this.accounts = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      const accounts = [];
      let changed = false;
      for (const account of parsed) {
        if (!account || typeof account !== 'object') continue;
        const rawId = String(account.id || '').trim();
        if (!SHOP_ID_PATTERN.test(rawId) || seen.has(rawId)) {
          changed = true;
          continue;
        }
        seen.add(rawId);
        if (rawId !== String(account.id || '')) changed = true;
        accounts.push({ ...account, id: rawId });
      }
      if (changed) {
        this.accounts = accounts;
        this.persist();
      }
      return accounts;
    } catch (_) {
      return [];
    }
  }

  list() {
    return this.accounts.map((account) => ({ ...account }));
  }

  get(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('账号不存在');
    return { ...account };
  }

  add(label, id) {
    const account = {
      id: String(id || '').trim(),
      label: String(label || `闲鱼账号 ${this.accounts.length + 1}`).slice(0, 40),
      createdAt: new Date().toISOString(),
      status: 'unknown',
    };
    if (!SHOP_ID_PATTERN.test(account.id)) {
      throw new TypeError('闲鱼账号需要有效的 shop_id');
    }
    if (this.accounts.some((item) => item.id === account.id)) {
      return this.get(account.id);
    }
    this.accounts.push(account);
    this.persist();
    return { ...account };
  }

  update(accountId, patch = {}) {
    const index = this.accounts.findIndex((item) => item.id === accountId);
    if (index < 0) throw new Error('账号不存在');
    const current = this.accounts[index];
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.accounts[index] = next;
    this.persist();
    return { ...next };
  }

  remove(accountId) {
    const index = this.accounts.findIndex((item) => item.id === accountId);
    if (index < 0) return false;
    this.accounts.splice(index, 1);
    this.persist();
    return true;
  }

  move(accountId, nextAccountId) {
    const sourceId = String(accountId || '').trim();
    const targetId = String(nextAccountId || '').trim();
    if (!SHOP_ID_PATTERN.test(targetId)) {
      throw new TypeError('闲鱼账号需要有效的 shop_id');
    }
    const index = this.accounts.findIndex((item) => item.id === sourceId);
    if (index < 0) throw new Error('账号不存在');
    if (sourceId === targetId) return this.get(sourceId);
    if (this.accounts.some((item) => item.id === targetId)) {
      throw new Error('目标账号已存在');
    }
    const current = this.accounts[index];
    // 身份迁移后继续复用原分区，避免把 Electron 的 Cookie、IndexedDB
    // 和其他登录状态复制一遍。账号 ID 本身已经是真实 shop_id。
    const partitionId = String(current.partitionId || current.id).trim();
    const moved = { ...current, id: targetId, partitionId };
    this.accounts[index] = moved;
    this.persist();
    return { ...moved };
  }

  persist() {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fs.writeFileSync(this.filePath, JSON.stringify(this.accounts, null, 2));
  }
}

module.exports = { JsonAccountRepository };
