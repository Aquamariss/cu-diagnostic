// HTTP-приложение диагностики на Hono (стандартные Request/Response).
// Используется и локальным сервером (server.js), и функцией Netlify (netlify/functions/api.mjs).

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import crypto from 'node:crypto';
import { SEGMENTS, QUESTIONS, MAX_SCORE } from '../public/js/questions.js';
import { normalizeAnswers, buildResult, SCORED_IDS } from './scoring.js';
import { aiEnabled } from './ai.js';
import * as store from './store.js';

const SCHOOL_URL = 'https://cityuniversity.ru/school-urban-producers';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AI_PENDING_TTL_MS = 3 * 60 * 1000; // через сколько «зависшую» персонализацию можно перезапустить

/**
 * @param {object} options
 * @param {(id: string, origin: string) => Promise<void>|void} options.triggerPersonalize
 *        запускает фоновую персонализацию заявки
 */
export function createApp({ triggerPersonalize }) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
  const PUBLIC_CONFIG = {
    consultationUrl: process.env.CONSULTATION_URL || SCHOOL_URL,
    schoolUrl: process.env.SCHOOL_URL || SCHOOL_URL,
    privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://cityuniversity.ru/policy',
    aiEnabled,
  };

  const app = new Hono();
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));

  const readBody = async (c) => {
    try {
      const data = await c.req.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  };
  const originOf = (c) => new URL(c.req.url).origin;

  app.get('/api/config', (c) => c.json(PUBLIC_CONFIG));

  // Шаг 0: ФИ и email до начала опроса — контакт сохраняется, даже если опрос не завершён.
  app.post('/api/start', async (c) => {
    const b = await readBody(c);
    const name = String(b.name ?? '').trim().slice(0, 120);
    const email = String(b.email ?? '').trim().toLowerCase().slice(0, 160);
    const segment = SEGMENTS.some((s) => s.id === b.segment) ? b.segment : null;
    const errors = {};
    if (name.length < 2) errors.name = 'Укажите имя и фамилию';
    if (!EMAIL_RE.test(email)) errors.email = 'Проверьте email';
    if (!segment) errors.segment = 'Выберите вариант';
    if (b.consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных';
    if (Object.keys(errors).length) return c.json({ errors }, 400);

    const record = await store.create({
      name,
      email,
      segment,
      consentAt: new Date().toISOString(),
      utm: pickUtm(b.utm),
      referrer: String(b.referrer ?? '').slice(0, 300),
      userAgent: String(c.req.header('user-agent') ?? '').slice(0, 300),
    });
    return c.json({ id: record.id });
  });

  // Промежуточное сохранение — администратор видит, на каком вопросе человек остановился.
  app.post('/api/progress/:id', async (c) => {
    const step = Number((await readBody(c)).step);
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    if (record.status !== 'completed' && Number.isInteger(step) && step >= 0 && step <= QUESTIONS.length) {
      await store.update(record.id, { lastStep: step });
    }
    return c.json({ ok: true });
  });

  // Шаг 1 → 2: ответы → мгновенный результат по методике.
  app.post('/api/submit/:id', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const { answers, errors } = normalizeAnswers((await readBody(c)).answers);
    if (errors.length) return c.json({ errors }, 400);

    const result = buildResult({ answers, segment: record.segment });
    await store.update(record.id, {
      answers,
      result,
      status: 'completed',
      completedAt: new Date().toISOString(),
      lastStep: QUESTIONS.length,
      aiStatus: null,
    });
    return c.json({ id: record.id, name: record.name, result });
  });

  // Запуск персонализации текстов через ИИ. Сам результат клиент забирает через /api/result.
  app.post('/api/personalize/:id', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record?.result) return c.json({ error: 'not_found' }, 404);
    if (!aiEnabled || record.result.personalized) return c.json({ status: 'done' });
    if (record.aiStatus === 'error') return c.json({ status: 'error' });

    const startedAt = Date.parse(record.aiStartedAt ?? '') || 0;
    if (record.aiStatus === 'pending' && Date.now() - startedAt < AI_PENDING_TTL_MS) {
      return c.json({ status: 'pending' });
    }
    await store.update(record.id, { aiStatus: 'pending', aiStartedAt: new Date().toISOString() });
    await triggerPersonalize(record.id, originOf(c));
    return c.json({ status: 'pending' });
  });

  // Результат по постоянной ссылке (и опрос статуса персонализации).
  app.get('/api/result/:id', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record?.result) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ id: record.id, name: record.name, result: record.result, aiStatus: record.aiStatus ?? null });
  });

  app.post('/api/cta/:id', async (c) => {
    const { type } = await readBody(c);
    if (['consultation', 'school'].includes(type)) {
      await store.update(c.req.param('id'), (r) => ({
        ctaClicks: [...(r.ctaClicks ?? []), { type, at: new Date().toISOString() }],
      }));
    }
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Администрирование: список заявок и выгрузка CSV (HTTP Basic, пароль из ADMIN_PASSWORD)
  // -------------------------------------------------------------------------

  const requireAdmin = async (c, next) => {
    if (!ADMIN_PASSWORD) {
      return c.text('Админка выключена: задайте переменную окружения ADMIN_PASSWORD.', 503);
    }
    const [scheme, encoded] = (c.req.header('authorization') ?? '').split(' ');
    const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    const a = crypto.createHash('sha256').update(password).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      c.header('WWW-Authenticate', 'Basic realm="cu-diagnostic admin", charset="UTF-8"');
      return c.text('Требуется авторизация', 401);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  };
  app.use('/admin', requireAdmin);
  app.use('/admin/*', requireAdmin);

  app.get('/admin', async (c) => {
    const rows = await store.all();
    const done = rows.filter((r) => r.status === 'completed').length;
    const clicked = rows.filter((r) => r.ctaClicks?.length).length;
    const body = rows
      .map((r) => {
        const clicks = (r.ctaClicks ?? []).map((x) => (x.type === 'consultation' ? 'консультация' : 'школа'));
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
    return c.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
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

  app.get('/admin/export.csv', async (c) => {
    const origin = originOf(c);
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
      ['cta_consultation', (r) => (r.ctaClicks ?? []).filter((x) => x.type === 'consultation').length],
      ['cta_school', (r) => (r.ctaClicks ?? []).filter((x) => x.type === 'school').length],
      ['utm', (r) => new URLSearchParams(r.utm ?? {}).toString()],
      ['referrer', (r) => r.referrer ?? ''],
      ['answers_json', (r) => (r.answers ? JSON.stringify(r.answers) : '')],
      ['result_url', (r) => (r.result ? `${origin}/r/${r.id}` : '')],
    ];
    const cell = (v) => {
      const s = String(v ?? '');
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // защита от CSV-инъекций в Excel
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = await store.all();
    const lines = [cols.map(([h]) => h).join(';'), ...rows.map((r) => cols.map(([, f]) => cell(f(r))).join(';'))];
    return c.body('﻿' + lines.join('\r\n'), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="diagnostic-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '');
const segmentLabel = (id) => SEGMENTS.find((s) => s.id === id)?.label ?? '';

function pickUtm(utm) {
  const out = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (typeof utm?.[key] === 'string' && utm[key]) out[key] = utm[key].slice(0, 120);
  }
  return out;
}
