import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswers, buildResult } from '../src/scoring.js';
import { mergeIntoResult } from '../src/ai.js';

const allNo = { audience: 'no', value: 'no', participants: 'no', partners: 'no', resources: 'no', funding: 'no', costs: 'no', revenue: 'no' };
const base = buildResult({
  answers: normalizeAnswers({
    q1: 'first_steps', q2: 'event', q3: ['residents'], q4: 'Соседские праздники во дворах, чтобы жители познакомились.',
    q5: 'b', q6: 'alone', q7: ['launch'], q8: allNo, q9: 'started', q10: 'no_analysis',
    q11: 'who', q12: 'talks', q13: ['venue'], q14: 'stops', q15: 'team',
  }).answers,
  segment: 'private',
});

test('ИИ меняет только тексты, но не выбор показателей и баллы', () => {
  const g = base.growthZones[0];
  const merged = mergeIntoResult(base, {
    strengths: [{ id: 'q5', text: 'Персональный текст про ценность соседских праздников и результат для жителей.' }],
    growth_zones: [
      { id: g.id, text: 'Персональный текст зоны роста для соседских праздников во дворах.' },
      { id: 'q11_fake', text: 'Лишняя зона, которой нет в методике, должна быть проигнорирована.' },
    ],
    potential: 'Потенциал '.repeat(10),
    next_step: 'Ближайший шаг '.repeat(10),
    roadmap: Array.from({ length: 8 }, (_, i) => ({ title: `Шаг ${i + 1}`, text: 'Описание шага для проекта соседских праздников.' })),
    problem_unclear: false,
  });
  assert.equal(merged.total, base.total);
  assert.deepEqual(merged.growthZones.map((x) => x.id), base.growthZones.map((x) => x.id));
  assert.deepEqual(merged.strengths.map((x) => x.id), base.strengths.map((x) => x.id));
  assert.match(merged.growthZones[0].text, /Персональный/);
  assert.equal(merged.growthZones[1].text, base.growthZones[1].text);
  assert.equal(merged.roadmap.length, 8);
  assert.equal(merged.personalized, true);
});

test('пустой или битый ответ ИИ оставляет шаблон', () => {
  const merged = mergeIntoResult(base, { roadmap: [{ title: 'Один' }], potential: '' });
  assert.equal(merged.potential, base.potential);
  assert.equal(merged.nextStep, base.nextStep);
  assert.deepEqual(merged.roadmap, base.roadmap);
});
