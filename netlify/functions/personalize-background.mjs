// Netlify Background Function (суффикс -background, до 15 минут): персонализирует результат
// через Claude и сохраняет его в Netlify Blobs. Клиент забирает тексты, опрашивая /api/result/:id.
import { runPersonalization } from '../../src/personalize-job.js';

export default async (req) => {
  let id;
  try {
    ({ id } = await req.json());
  } catch {
    return;
  }
  if (typeof id === 'string') await runPersonalization(id);
};
