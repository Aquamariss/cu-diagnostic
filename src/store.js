// Простое хранилище заявок: JSON-файл на диске сервера.
// Временное решение до появления базы данных и авторизации.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'submissions.json');

let records = new Map();
let writeTimer = null;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    records = new Map(list.map((r) => [r.id, r]));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Не удалось прочитать хранилище:', err.message);
  }
}

function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...records.values()], null, 2));
  fs.renameSync(tmp, FILE);
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      flush();
    } catch (err) {
      console.error('Не удалось сохранить хранилище:', err.message);
    }
  }, 200);
}

export function create(fields) {
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomBytes(12).toString('base64url'),
    createdAt: now,
    updatedAt: now,
    status: 'started',
    ctaClicks: [],
    ...fields,
  };
  records.set(record.id, record);
  scheduleWrite();
  return record;
}

export function get(id) {
  return records.get(id) ?? null;
}

export function update(id, patch) {
  const record = records.get(id);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  scheduleWrite();
  return record;
}

export function all() {
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function flushNow() {
  clearTimeout(writeTimer);
  flush();
}

load();
