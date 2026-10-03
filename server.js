// Локальный запуск: npm start → http://localhost:3000
import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './src/app.js';
import { runPersonalization } from './src/personalize-job.js';
import { aiEnabled } from './src/ai.js';
import { storageName } from './src/store.js';

const PORT = Number(process.env.PORT) || 3000;

const app = createApp({
  // Локально персонализация идёт в том же процессе; клиент опрашивает /api/result.
  triggerPersonalize: (id) => {
    runPersonalization(id).catch((err) => console.error('Ошибка персонализации:', err));
  },
});

// Статика и постоянные ссылки на результат (на Netlify это делает CDN и netlify.toml).
app.use('/*', serveStatic({ root: './public' }));
app.get('/r/:id', (c) => c.html(fs.readFileSync('./public/index.html', 'utf8')));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Диагностика запущена: http://localhost:${PORT}`);
  console.log(`ИИ-персонализация: ${aiEnabled ? 'включена' : 'выключена (нет ANTHROPIC_API_KEY)'}`);
  console.log(`Хранилище: ${storageName()}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Админка выключена: задайте ADMIN_PASSWORD');
});
