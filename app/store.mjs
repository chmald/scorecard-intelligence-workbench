import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ConflictError extends Error {
  constructor() { super('State changed; refresh and retry.'); this.status = 409; this.code = 'CONFLICT'; }
}

export const emptyState = () => ({
  customers: [], documents: [], records: [], actions: [], momentum: [], published: [],
  auditLog: [], approvals: {}, hiddenItems: false, trends: [], escalations: [],
});

export class JsonStateStore {
  constructor(file) { this.file = file; this.revision = 0; this.queue = Promise.resolve(); }
  async read() {
    try {
      const { revision, state } = JSON.parse(await readFile(this.file, 'utf8'));
      return { state, etag: revision };
    } catch (error) {
      if (error.code === 'ENOENT') return { state: emptyState(), etag: 0 };
      throw error;
    }
  }
  async write(state, etag) {
    const operation = this.queue.then(async () => {
      const current = await this.read();
      if (current.etag !== etag) throw new ConflictError();
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.pending`;
      await writeFile(temporary, JSON.stringify({ revision: etag + 1, state }), { mode: 0o600 });
      await rename(temporary, this.file);
      return etag + 1;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export class MemoryStateStore {
  constructor() { this.state = emptyState(); this.etag = 0; }
  async read() { return { state: structuredClone(this.state), etag: this.etag }; }
  async write(state, etag) {
    if (etag !== this.etag) throw new ConflictError();
    this.state = structuredClone(state);
    return ++this.etag;
  }
}

export class CosmosStateStore {
  constructor(container, id = 'workbench') { this.container = container; this.id = id; }
  async read() {
    try {
      const { resource } = await this.container.item(this.id, this.id).read();
      if (!resource) return { state: emptyState(), etag: null };
      return { state: resource.state, etag: resource._etag };
    } catch (error) {
      if (error.code === 404 || error.statusCode === 404) return { state: emptyState(), etag: null };
      throw error;
    }
  }
  async write(state, etag) {
    try {
      const document = { id: this.id, partitionKey: this.id, state };
      const result = etag
        ? await this.container.item(this.id, this.id).replace(document, { accessCondition: { type: 'IfMatch', condition: etag } })
        : await this.container.items.create(document);
      return result.resource?._etag ?? result.etag;
    } catch (error) {
      if ([409, 412].includes(error.code) || [409, 412].includes(error.statusCode)) throw new ConflictError();
      throw error;
    }
  }
}
