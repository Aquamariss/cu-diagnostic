import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { SEGMENTS, QUESTIONS, MAX_SCORE } from './public/js/questions.js';
import { normalizeAnswers, buildResult, SCORED_IDS } from './src/scoring.js';
import { personalize, aiEnabled } from './src/ai.js';
import * as store from './src/store.js';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCHOOL_URL = 'https://cityuniversity.ru/school-urban-producers';

const PUBLIC_CONFIG = {
  consultationUrl: process.env.CONSULTATION_URL || SCHOOL_URL,
  schoolUrl: process.env.SCHOOL_URL || SCHOOL_URL,
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://cityuniversity.ru/policy',
  aiEnabled,
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pending = new Map(); // id → Promise персонализации, чтобы не запускать её дважды

app.get('/api/config', (req, res) => res.json(PUBLIC_CONFIG));

// Шаг 0: ФИ и email до начала опроса — контакт сохраняется, даже если опрос не завершён.
app.post('/api/start', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 120);
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 160);
  const segment = SEGMENTS.some((s) => s.id === req.body?.segment) ? req.body.segment : null;
  const errors = {};
  if (name.length < 2) errors.name = 'Укажите имя и фамилию';
  if (!EMAIL_RE.test(email)) errors.email = 'Проверьте email';
  if (!segment) errors.segment = 'Выберите вариант';
  if (req.body?.consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const record = store.create({
    name,
    email,
    segment,
    consentAt: new Date().toISOString(),
    utm: pickUtm(req.body?.utm),
    referrer: String(req.body?.referrer ?? '').slice(0, 300),
    userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
  });
  res.json({ id: record.id });
});

// Промежуточное сохранение ответов — чтобы администратор видел, на каком вопросе человек остановился.
app.post('/api/progress/:id', (req, res) => {
  const record = store.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'not_found' });
  if (record.status === 'completed') return res.json({ ok: true });
  const step = Number(req.body?.step);
  if (Number.isInteger(step) && step >= 0 && step <= QUESTIONS.length) {
    store.update(record.id, { lastStep: step });
  }
  res.json({ ok: true });
});

// Шаг 1 → 2: ответы → мгновенный результат по методике.
app.post('/api/submit/:id', (req, res) => {
  const record = store.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'not_found' });
  const { answers, errors } = normalizeAnswers(req.body?.answers);
  if (errors.length) return res.status(400).json({ errors });

  const result = buildResult({ answers, segment: record.segment });
  store.update(record.id, {
    answers,
    result,
    status: 'completed',
    completedAt: new Date().toISOString(),
    lastStep: QUESTIONS.length,
  });
  res.json({ id: record.id, name: record.name, result });
});

// Персонализация текстов через ИИ. Вызывается после показа результата.
app.post('/api/personalize/:id', async (req, res) => {
  const record = store.get(req.params.id);
  if (!record?.result) return res.status(404).json({ error: 'not_found' });
  if (record.result.personalized || !aiEnabled) return res.json({ result: record.result });

  if (!pending.has(record.id)) {
    pending.set(
      record.id,
      personalize(record)
        .then((personalized) => {
          if (personalized) store.update(record.id, { result: personalized, personalizedAt: new Date().toISOString() });
          else store.update(record.id, { aiError: 'empty_or_invalid' });
        })
        .catch((err) => {
          console.error('Ошибка персонализации:', err?.status ?? '', err?.message);
          store.update(record.id, { aiError: String(err?.message ?? err).slice(0, 300) });
        })
        .finally(() => pending.delete(record.id)),
    );
  }
  await pending.get(record.id);
  res.json({ result: store.get(record.id).result });
});

// Результат по постоянной ссылке.
app.get('/api/result/:id', (req, res) => {
  const record = store.get(req.params.id);
  if (!record?.result) return res.status(404).json({ error: 'not_found' });
  res.json({ id: record.id, name: record.name, result: record.result });
});

app.post('/api/cta/:id', (req, res) => {
  const record = store.get(req.params.id);
  const type = ['consultation', 'school'].includes(req.body?.type) ? req.body.type : null;
  if (record && type) {
    store.update(record.id, { ctaClicks: [...(record.ctaClicks ?? []), { type, at: new Date().toISOString() }] });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Администрирование: список заявок и выгрузка CSV (HTTP Basic, пароль из ADMIN_PASSWORD)
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).type('text/plain; charset=utf-8').send('Админка выключена: задайте переменную окружения ADMIN_PASSWORD.');
  }
  const [scheme, encoded] = (req.get('authorization') ?? '').split(' ');
  const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    res.set('WWW-Authenticate', 'Basic realm="cu-diagnostic admin", charset="UTF-8"');
    return res.status(401).send('Требуется авторизация');
  }
  next();
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '');
const segmentLabel = (id) => SEGMENTS.find((s) => s.id === id)?.label ?? '';

app.get('/admin', requireAdmin, (req, res) => {
  const rows = store.all();
  const done = rows.filter((r) => r.status === 'completed').length;
  const clicked = rows.filter((r) => r.ctaClicks?.length).length;
  const body = rows
    .map((r) => {
      const clicks = (r.ctaClicks ?? []).map((c) => (c.type === 'consultation' ? 'консультация' : 'школа'));
      return `<tr>
        <td>${esc(fmtDate(r.createdAt))}</td>
        <td>${esc(r.name)}</td>
        <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
        <td>${esc(segmentLabel(r.segment))}</td>
        <td>${r.status === 'completed' ? 'завершил(а)' : `вопрос ${(r.lastStep ?? 0) + 1} из ${QUESTIONS.length}`}</td>
        <td>${esc(r.result?.stage?.label ?? '')}</td>
        <td>${esc(r.result?.format ?? '')}</td>
        <td>${r.result ? `${r.result.total}/${MAX_SCORE}` : ''}</td>
        <td>${esc(r.result?.need?.label ?? '')}</td>
        <td>${esc([...new Set(clicks)].join(', '))}</td>
        <td>${r.result ? `<a href="/r/${esc(r.id)}" target="_blank">открыть</a>` : ''}</td>
      </tr>`;
    })
    .join('');
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Заявки — диагностика</title><link rel="stylesheet" href="/css/admin.css"></head><body>
<header><h1>Заявки на диагностику</h1>
<p>Всего: <b>${rows.length}</b> · Завершили: <b>${done}</b> · Кликнули CTA: <b>${clicked}</b>
 · ИИ-персонализация: <b>${aiEnabled ? 'включена' : 'выключена'}</b></p>
<a class="btn" href="/admin/export.csv">Скачать CSV</a></header>
<div class="table-wrap"><table><thead><tr>
<th>Дата (МСК)</th><th>ФИ</th><th>Email</th><th>Профиль</th><th>Статус</th><th>Стадия</th><th>Формат</th>
<th>Баллы</th><th>Запрос</th><th>CTA</th><th>Результат</th></tr></thead>
<tbody>${body || '<tr><td colspan="11">Пока нет заявок</td></tr>'}</tbody></table></div></body></html>`);
});

app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const cols = [
    ['id', (r) => r.id],
    ['created_at', (r) => r.createdAt],
    ['name', (r) => r.name],
    ['email', (r) => r.email],
    ['segment', (r) => segmentLabel(r.segment)],
    ['status', (r) => r.status],
    ['last_step', (r) => r.lastStep ?? ''],
    ['completed_at', (r) => r.completedAt ?? ''],
    ['stage', (r) => r.result?.stage?.label ?? ''],
    ['format', (r) => r.result?.format ?? ''],
    ['audience', (r) => r.result?.audience ?? ''],
    ['problem', (r) => r.answers?.q4 ?? ''],
    ['need', (r) => r.result?.need?.label ?? ''],
    ['total', (r) => r.result?.total ?? ''],
    ...SCORED_IDS.map((id) => [id, (r) => r.result?.scores?.find((s) => s.id === id)?.score ?? '']),
    ['strengths', (r) => (r.result?.strengths ?? []).map((s) => s.title).join('; ')],
    ['growth_zones', (r) => (r.result?.growthZones ?? []).map((s) => s.title).join('; ')],
    ['personalized', (r) => (r.result ? (r.result.personalized ? 'да' : 'нет') : '')],
    ['cta_consultation', (r) => (r.ctaClicks ?? []).filter((c) => c.type === 'consultation').length],
    ['cta_school', (r) => (r.ctaClicks ?? []).filter((c) => c.type === 'school').length],
    ['utm', (r) => new URLSearchParams(r.utm ?? {}).toString()],
    ['referrer', (r) => r.referrer ?? ''],
    ['answers_json', (r) => (r.answers ? JSON.stringify(r.answers) : '')],
    ['result_url', (r) => (r.result ? `${req.protocol}://${req.get('host')}/r/${r.id}` : '')],
  ];
  const cell = (v) => {
    const s = String(v ?? '');
    // Защита от CSV-инъекций в Excel
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map(([h]) => h).join(';'), ...store.all().map((r) => cols.map(([, f]) => cell(f(r))).join(';'))];
  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="diagnostic-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send('﻿' + lines.join('\r\n'));
});

function pickUtm(utm) {
  const out = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (typeof utm?.[key] === 'string' && utm[key]) out[key] = utm[key].slice(0, 120);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Статика и SPA
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.resolve('public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/r/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`Диагностика запущена: http://localhost:${PORT}`);
  console.log(`ИИ-персонализация: ${aiEnabled ? 'включена' : 'выключена (нет ANTHROPIC_API_KEY)'}`);
  if (!ADMIN_PASSWORD) console.log('Админка выключена: задайте ADMIN_PASSWORD');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flushNow();
    server.close(() => process.exit(0));
  });
}
