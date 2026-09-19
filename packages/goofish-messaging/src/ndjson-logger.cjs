const fs = require('node:fs');
const path = require('node:path');

class NdjsonLogger {
  constructor({ directory, fsModule = fs } = {}) {
    this.directory = directory || null;
    this.fs = fsModule;
    if (this.directory) this.fs.mkdirSync(this.directory, { recursive: true });
  }

  write(kind, payload) {
    if (!this.directory) return;
    try {
      this.fs.mkdirSync(this.directory, { recursive: true });
      const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload }, (_key, value) => typeof value === 'bigint' ? String(value) : value);
      this.fs.appendFileSync(path.join(this.directory, `${kind}.ndjson`), `${line}\n`, 'utf8');
    } catch (_) {}
  }
}

module.exports = { NdjsonLogger };
