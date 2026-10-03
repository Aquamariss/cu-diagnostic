// Фоновая персонализация результата: читает заявку, вызывает Claude, сохраняет тексты.
// Локально запускается в том же процессе, на Netlify — в фоновой функции (до 15 минут).

import { personalize } from './ai.js';
import * as store from './store.js';

export async function runPersonalization(id) {
  const record = await store.get(id);
  if (!record?.result || record.result.personalized || record.aiStatus !== 'pending') return;
  try {
    const result = await personalize(record);
    if (result) {
      await store.update(id, { result, aiStatus: 'done', personalizedAt: new Date().toISOString() });
    } else {
      await store.update(id, { aiStatus: 'error', aiError: 'empty_or_invalid' });
    }
  } catch (err) {
    console.error('Ошибка персонализации:', err?.status ?? '', err?.message);
    await store.update(id, { aiStatus: 'error', aiError: String(err?.message ?? err).slice(0, 300) });
  }
}
