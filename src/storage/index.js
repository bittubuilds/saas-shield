'use strict';
// Blob storage for captured screenshots.
//
// Two providers, both free, both behind one interface:
//
//   local  - files on disk under config.screenshots.dir (default data/screenshots)
//   memory - an in-process map, used by tests and as a fallback when the filesystem
//            is read-only
//
// The interface is deliberately small: put, get, delete, describe. A future
// provider (an object store, a paid bucket) slots in here without touching the
// capture layer, the database rows or the routes.
//
// DURABILITY: neither provider is durable production storage. The local provider is
// a directory on the machine running the process; on an ephemeral host such as a
// Render free instance that directory disappears on every deploy, restart or
// spin-down, so the database would keep rows pointing at files that no longer
// exist. `describe().durable` is false for both, and every API response that lists
// screenshots carries that flag so a client can say so plainly.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_PATTERN = /^[A-Za-z0-9._/-]+$/;

function assertKey(key) {
  const k = String(key || '');
  if (!k || !KEY_PATTERN.test(k) || k.includes('..') || k.startsWith('/')) {
    const err = new Error('invalid storage key');
    err.code = 'STORAGE_BAD_KEY';
    throw err;
  }
  return k;
}

// Keys are workspace-scoped so one tenant's objects can never collide with, or be
// served as, another's.
function keyFor({ workspaceId, competitorId, contentHash, ext = 'png' }) {
  const ws = String(workspaceId).replace(/[^A-Za-z0-9_-]/g, '');
  const cmp = String(competitorId).replace(/[^A-Za-z0-9_-]/g, '');
  return assertKey(`${ws}/${cmp}/${contentHash}.${ext}`);
}

function localStorage({ dir }) {
  const root = path.resolve(dir);
  let ensured = false;

  async function ensure() {
    if (ensured) return;
    await fsp.mkdir(root, { recursive: true });
    ensured = true;
  }

  function resolve(key) {
    const abs = path.resolve(root, assertKey(key));
    // Belt and braces: the resolved path must stay inside the storage root.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      const err = new Error('storage key escapes the storage root');
      err.code = 'STORAGE_BAD_KEY';
      throw err;
    }
    return abs;
  }

  return {
    provider: 'local',
    describe() {
      return {
        provider: 'local',
        durable: false,
        location: root,
        warning: 'Local disk is not durable production storage. On an ephemeral host (Render free plan) '
          + 'these files are lost on deploy, restart or spin-down; the metadata rows survive but the images do not.'
      };
    },
    async put({ key, buffer }) {
      const k = assertKey(key);
      const abs = resolve(k);
      try {
        await ensure();
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        // Write to a temporary name then rename: a crash mid-write cannot leave a
        // half image under the final key.
        const tmp = `${abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, buffer);
        await fsp.rename(tmp, abs);
      } catch (e) {
        const err = new Error(`storage write failed: ${e.message}`);
        err.code = e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOSPC' ? 'STORAGE_WRITE_FAILED' : 'STORAGE_ERROR';
        err.cause = e;
        throw err;
      }
      return { key: k, bytes: buffer.length, url: null };
    },
    async get(key) {
      const abs = resolve(assertKey(key));
      try {
        const buffer = await fsp.readFile(abs);
        return { buffer, bytes: buffer.length };
      } catch (e) {
        if (e.code === 'ENOENT') {
          const err = new Error('screenshot file is missing from local storage');
          err.code = 'STORAGE_NOT_FOUND';
          throw err;
        }
        const err = new Error(`storage read failed: ${e.message}`);
        err.code = 'STORAGE_ERROR';
        throw err;
      }
    },
    async delete(key) {
      const abs = resolve(assertKey(key));
      try {
        await fsp.unlink(abs);
        return true;
      } catch (e) {
        if (e.code === 'ENOENT') return false;
        const err = new Error(`storage delete failed: ${e.message}`);
        err.code = 'STORAGE_ERROR';
        throw err;
      }
    },
    // Used by tests and by the health endpoint; never required by the capture path.
    async exists(key) {
      try {
        await fsp.access(resolve(assertKey(key)));
        return true;
      } catch {
        return false;
      }
    },
    stats() {
      try {
        const files = fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.png'));
        return { files: files.length };
      } catch {
        return { files: 0 };
      }
    }
  };
}

function memoryStorage() {
  const blobs = new Map();
  return {
    provider: 'memory',
    describe() {
      return {
        provider: 'memory',
        durable: false,
        location: 'process memory',
        warning: 'In-memory storage is never durable: images disappear when the process exits.'
      };
    },
    async put({ key, buffer }) {
      const k = assertKey(key);
      blobs.set(k, Buffer.from(buffer));
      return { key: k, bytes: buffer.length, url: null };
    },
    async get(key) {
      const k = assertKey(key);
      const buffer = blobs.get(k);
      if (!buffer) {
        const err = new Error('screenshot is not in memory storage');
        err.code = 'STORAGE_NOT_FOUND';
        throw err;
      }
      return { buffer, bytes: buffer.length };
    },
    async delete(key) {
      return blobs.delete(assertKey(key));
    },
    async exists(key) {
      return blobs.has(assertKey(key));
    },
    stats() {
      return { files: blobs.size };
    }
  };
}

const PROVIDERS = ['local', 'memory'];

function createStorage({ provider = 'local', dir } = {}) {
  if (!PROVIDERS.includes(provider)) {
    const err = new Error(`unknown storage provider: ${provider}`);
    err.code = 'STORAGE_BAD_PROVIDER';
    throw err;
  }
  return provider === 'memory' ? memoryStorage() : localStorage({ dir });
}

// One provider instance per (provider, dir) for the life of the process. This matters
// for the in-memory provider, whose data belongs to the instance: the capture path and
// the image route must talk to the same store, or a freshly captured image would be
// unreadable. It also stops every request from rebuilding a filesystem handle.
const cache = new Map();

function getStorage({ provider, dir } = {}) {
  const p = provider || 'local';
  // The directory is meaningless to the memory provider, so it must not split the
  // cache: a capture and the route that serves it would otherwise see two stores.
  const key = p === 'memory' ? 'memory' : `${p}:${dir || ''}`;
  if (!cache.has(key)) cache.set(key, createStorage({ provider: p, dir }));
  return cache.get(key);
}

function resetStorageCache() {
  cache.clear();
}

module.exports = { createStorage, getStorage, resetStorageCache, PROVIDERS, keyFor, assertKey };
