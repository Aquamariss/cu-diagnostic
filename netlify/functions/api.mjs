// Netlify Function (v2): всё API и админка — то же приложение, что и локально.
import { createApp } from '../../src/app.js';

const app = createApp({
  // Персонализация через Claude может идти дольше лимита обычной функции (60 с),
  // поэтому запускаем фоновую функцию (до 15 минут) и сразу отвечаем клиенту.
  triggerPersonalize: async (id, origin) => {
    const res = await fetch(`${origin}/.netlify/functions/personalize-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.status !== 202) console.error('Фоновая функция не запустилась:', res.status);
  },
});

export default (req) => app.fetch(req);

export const config = {
  path: ['/api/*', '/admin', '/admin/*'],
};
