// Хранилище заявок. Временное решение до появления базы данных и авторизации.
//
// Два режима:
//   • Netlify — Netlify Blobs (постоянное хранилище сайта, не пропадает между запусками функций);
//   • локально — JSON-файл data/submissions.json.
// Режим выбирается автоматически: в функциях Netlify среда выполнения сама передаёт
// контекст Blobs (globalThis.netlifyBlobsContext / NETLIFY_BLOBS_CONTEXT).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const useBlobs = () =>
  Boolean(globalThis.netlifyBlobsContext || process.env.NETLIFY_BLOBS_CONTEXT) || process.env.STORAGE === 'blobs';

// ---------------------------------------------------------------------------
// Netlify Blobs
// ---------------------------------------------------------------------------

const blobs = () => getStore({ name: 'submissions', consistency: 'strong' });

const blobBackend = {
  async get(id) {
    return (await blobs().get(id, { type: 'json' })) ?? null;
  },
  async put(record) {
    await blobs().setJSON(record.id, record);
  },
  async all() {
    const store = blobs();
    const { blobs: list } = await store.list();
    const records = await Promise.all(list.map((b) => store.get(b.key, { type: 'json' })));
    return records.filter(Boolean);
  },
};

// ---------------------------------------------------------------------------
// Локальный JSON-файл
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'submissions.json');
let fileRecords = null;

function fileLoad() {
  if (fileRecords) return fileRecords;
  fileRecords = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) fileRecords.set(r.id, r);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Не удалось прочитать хранилище:', err.message);
  }
  return fileRecords;
}

function fileFlush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...fileLoad().values()], null, 2));
  fs.renameSync(tmp, FILE);
}

const fileBackend = {
  async get(id) {
    const r = fileLoad().get(id);
    return r ? structuredClone(r) : null;
  },
  async put(record) {
    fileLoad().set(record.id, structuredClone(record));
    fileFlush();
  },
  async all() {
    return [...fileLoad().values()].map((r) => structuredClone(r));
  },
};

const backend = () => (useBlobs() ? blobBackend : fileBackend);

// ---------------------------------------------------------------------------
// Публичный интерфейс
// ---------------------------------------------------------------------------

const ID_RE = /^[\w-]{8,64}$/;

export async function create(fields) {
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomBytes(12).toString('base64url'),
    createdAt: now,
    updatedAt: now,
    status: 'started',
    ctaClicks: [],
    ...fields,
  };
  await backend().put(record);
  return record;
}

export async function get(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return backend().get(id);
}

/** patch — объект или функция (record) => объект с изменениями. */
export async function update(id, patch) {
  const record = await get(id);
  if (!record) return null;
  const changes = typeof patch === 'function' ? patch(record) : patch;
  Object.assign(record, changes, { updatedAt: new Date().toISOString() });
  await backend().put(record);
  return record;
}

export async function all() {
  const list = await backend().all();
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const storageName = () => (useBlobs() ? 'Netlify Blobs' : `файл ${FILE}`);
