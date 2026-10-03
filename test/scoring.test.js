import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, MAX_SCORE } from '../public/js/questions.js';
import {
  normalizeAnswers, computeScores, buildResult, scoreQ7, scoreQ8, scoreQ13,
  pickGrowthZones, pickFocus, resultStage, INDICATORS, SCORED_IDS,
} from '../src/scoring.js';

const allYes = { audience: 'yes', value: 'yes', participants: 'yes', partners: 'yes', resources: 'yes', funding: 'yes', costs: 'yes', revenue: 'yes' };
const allNo = Object.fromEntries(Object.keys(allYes).map((k) => [k, 'no']));

const minimal = {
  q1: 'idea', q2: 'community', q3: ['kids'], q4: 'Помогаем подросткам находить сообщества по интересам в своём районе.',
  q5: 'a', q6: 'alone', q7: ['all_myself'], q8: allNo, q9: 'thinking', q10: 'none',
  q11: 'unknown', q12: 'none', q13: ['none'], q14: 'stops', q15: 'unknown',
};
const maximal = {
  q1: 'working', q2: 'place', q3: ['residents', 'families'], q4: 'Создаём соседский центр, где жители района сами организуют досуг.',
  q5: 'b', q6: 'team', q7: ['concept', 'team', 'resources', 'analysis'], q8: allYes, q9: 'regular', q10: 'changed',
  q11: 'sources', q12: 'demand', q13: ['audience', 'venue', 'partners', 'experts', 'funding'], q14: 'autonomous', q15: 'scaling',
};

test('максимальная сумма баллов — 17', () => {
  assert.equal(MAX_SCORE, 17);
  assert.equal(QUESTIONS.length, 15);
});

test('минимальные и максимальные ответы', () => {
  assert.equal(computeScores(normalizeAnswers(minimal).answers).total, 0);
  assert.equal(computeScores(normalizeAnswers(maximal).answers).total, 17);
});

test('Q7: роль автора', () => {
  assert.equal(scoreQ7(['launch', 'manage']), 0);
  assert.equal(scoreQ7(['all_myself']), 0);
  assert.equal(scoreQ7(['concept']), 1);
  assert.equal(scoreQ7(['concept', 'audience', 'product']), 1); // одна группа
  assert.equal(scoreQ7(['concept', 'partners', 'city']), 2);
  assert.equal(scoreQ7(['concept', 'partners', 'city', 'all_myself']), 1);
});

test('Q8: количество «Да»', () => {
  const m = (n) => Object.fromEntries(Object.keys(allYes).map((k, i) => [k, i < n ? 'yes' : 'no']));
  assert.deepEqual([0, 2, 3, 5, 6, 8].map((n) => scoreQ8(m(n))), [0, 0, 0.5, 0.5, 1, 1]);
});

test('Q13: виды ресурсов, «нет ресурсов» исключает остальные', () => {
  assert.equal(scoreQ13(['none']), 0);
  assert.equal(scoreQ13(['venue']), 0);
  assert.equal(scoreQ13(['venue', 'media']), 1);
  assert.equal(scoreQ13(['venue', 'media', 'tech', 'city', 'experts']), 2);
  const { answers } = normalizeAnswers({ ...minimal, q13: ['venue', 'none'] });
  assert.deepEqual(answers.q13, ['none']);
});

test('валидация: незаполненные и «Другое» с текстом', () => {
  const { errors } = normalizeAnswers({ ...minimal, q5: undefined, q4: 'а' });
  assert.deepEqual(errors.sort(), ['q4', 'q5']);
  const { answers } = normalizeAnswers({ ...minimal, q2: 'other', q2_other: 'Фестиваль-лаборатория' });
  assert.equal(answers.q2_other, 'Фестиваль-лаборатория');
});

test('интерпретация общего балла', () => {
  assert.equal(resultStage(0).id, 'forming');
  assert.equal(resultStage(4).id, 'forming');
  assert.equal(resultStage(4.5).id, 'transition');
  assert.equal(resultStage(8).id, 'transition');
  assert.equal(resultStage(8.5).id, 'foundation');
  assert.equal(resultStage(12).id, 'foundation');
  assert.equal(resultStage(12.5).id, 'sustainable');
  assert.equal(resultStage(17).id, 'sustainable');
});

test('зоны роста: сначала низкие баллы, при равенстве — запрос Q15', () => {
  const scores = { q5: 1, q6: 1, q7: 2, q8: 1, q9: 1, q10: 0.5, q11: 2, q12: 1, q13: 1, q14: 1 };
  assert.deepEqual(pickGrowthZones(scores, 'pilot', 'unknown'), ['q10', 'q12', 'q13']);
  assert.deepEqual(pickGrowthZones(scores, 'pilot', 'scaling'), ['q10', 'q14', 'q12']);
  const { focus, needMatched } = pickFocus(['q10', 'q14', 'q12'], 'scaling');
  assert.equal(focus, 'q14');
  assert.equal(needMatched, true);
});

test('у каждого возможного балла зоны роста есть текст', () => {
  for (const id of SCORED_IDS) {
    const q = QUESTIONS.find((x) => x.id === id);
    const possible = q.options?.filter((o) => 'score' in o).map((o) => o.score)
      ?? { q7: [0, 1, 2], q8: [0, 0.5, 1], q13: [0, 1, 2] }[id];
    for (const s of new Set(possible)) {
      if (s < q.max) assert.ok(INDICATORS[id].growthText[s], `${id}=${s}`);
    }
  }
});

test('полный результат: структура и ограничения', () => {
  for (const raw of [minimal, maximal]) {
    const { answers } = normalizeAnswers(raw);
    const r = buildResult({ answers, segment: 'nko' });
    assert.ok(r.total <= 17);
    assert.ok(r.strengths.length <= 3 && r.growthZones.length <= 3);
    assert.ok(r.strengths.every((s) => s.score === s.max));
    assert.ok(r.growthZones.every((g) => g.score < g.max && g.text));
    assert.ok(r.roadmap.length >= 5 && r.roadmap.length <= 8, `roadmap ${r.roadmap.length}`);
    assert.ok(r.potential.length > 100 && r.nextStep.length > 100);
    assert.equal(r.segment.profile, 'B2B');
  }
});

test('стадия «идея» не получает шагов про масштабирование', () => {
  const { answers } = normalizeAnswers({ ...minimal, q15: 'scaling' });
  const r = buildResult({ answers, segment: 'private' });
  assert.ok(!r.roadmap.some((s) => /тиражирован|масштаб/i.test(s.title)));
  assert.ok(!/масштаб/i.test(r.nextStep));
  // Запрос, не совпавший с зонами роста, упоминается в ближайшем шаге
  const r2 = buildResult({ answers: normalizeAnswers({ ...maximal, q1: 'pilot', q10: 'feedback', q15: 'promotion' }).answers, segment: 'private' });
  assert.equal(r2.focus, 'q10');
  assert.match(r2.nextStep, /научиться продвигать проект/);
});
