import { QUESTIONS, BLOCKS, SEGMENTS } from './questions.js';

const app = document.getElementById('app');
const STORAGE_KEY = 'cu-diagnostic-v1';

let config = { consultationUrl: '', schoolUrl: '', privacyPolicyUrl: '', aiEnabled: false };
let state = loadState(); // { id, name, step, answers }

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // только для статичной разметки
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* приватный режим — работаем без сохранения */
  }
}

function resetState() {
  state = {};
  saveState();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

const fmt = (n) => String(n).replace('.', ',');

function render(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Экран 0: старт — ФИ, email, профиль, согласие
// ---------------------------------------------------------------------------

function renderIntro() {
  const resume = state.id && state.step != null && !state.done;

  const form = h('form', { class: 'card form', novalidate: true });
  const field = (name, label, input, hint) =>
    h('label', { class: 'field', for: `f-${name}` },
      h('span', { class: 'field__label' }, label),
      input,
      hint ? h('span', { class: 'field__hint' }, hint) : null,
      h('span', { class: 'field__error', 'data-error': name }),
    );

  const nameInput = h('input', { id: 'f-name', name: 'name', type: 'text', autocomplete: 'name', placeholder: 'Анна Иванова', required: true, maxlength: 120 });
  const emailInput = h('input', { id: 'f-email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'anna@example.ru', required: true, maxlength: 160 });
  const segSelect = h('select', { id: 'f-segment', name: 'segment', required: true },
    h('option', { value: '' }, 'Выберите вариант'),
    SEGMENTS.map((s) => h('option', { value: s.id }, s.label)),
  );
  const consent = h('input', { type: 'checkbox', name: 'consent', id: 'f-consent' });
  const submit = h('button', { class: 'btn btn--primary btn--lg', type: 'submit' }, 'Начать диагностику');

  form.append(
    h('h2', { class: 'form__title' }, 'Начнём знакомство'),
    field('name', 'Имя и фамилия', nameInput),
    field('email', 'Email', emailInput, 'Сюда эксперты смогут написать по вашему проекту'),
    field('segment', 'Вы представляете', segSelect),
    h('label', { class: 'check check--consent' },
      consent,
      h('span', {},
        'Я согласен(на) на обработку персональных данных в соответствии с ',
        h('a', { href: config.privacyPolicyUrl, target: '_blank', rel: 'noopener' }, 'политикой конфиденциальности'),
      ),
    ),
    h('span', { class: 'field__error', 'data-error': 'consent' }),
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('[data-error]').forEach((el) => (el.textContent = ''));
    submit.disabled = true;
    submit.textContent = 'Секунду…';
    try {
      const params = new URLSearchParams(location.search);
      const utm = Object.fromEntries([...params].filter(([k]) => k.startsWith('utm_')));
      const { id } = await api('/api/start', {
        name: nameInput.value,
        email: emailInput.value,
        segment: segSelect.value,
        consent: consent.checked,
        utm,
        referrer: document.referrer,
      });
      state = { id, name: nameInput.value.trim(), step: 0, answers: {} };
      saveState();
      renderQuestion();
    } catch (err) {
      const errors = err.data?.errors ?? {};
      for (const [k, msg] of Object.entries(errors)) {
        const el = form.querySelector(`[data-error="${k}"]`);
        if (el) el.textContent = msg;
      }
      if (!Object.keys(errors).length) alert('Не удалось начать диагностику. Попробуйте ещё раз.');
      submit.disabled = false;
      submit.textContent = 'Начать диагностику';
    }
  });

  const benefits = [
    ['Тип и формат', 'Определите тип и формат своего проекта'],
    ['Сильные стороны', 'Узнаете, что в проекте уже работает'],
    ['Зоны роста', 'Определите главные точки развития'],
    ['Потенциал', 'Поймёте, каким может стать следующий уровень'],
    ['Ближайший шаг', 'Получите одно конкретное действие'],
    ['Роадмап на год', 'План шагов, которые реально сделать за год'],
  ];

  render(
    h('section', { class: 'hero' },
      h('div', { class: 'hero__text' },
        h('p', { class: 'eyebrow' }, 'Бесплатная диагностика · 7 минут'),
        h('h1', { class: 'hero__title' }, 'Диагностика городского проекта'),
        h('p', { class: 'hero__lead' },
          'Пройдите опрос за 7 минут — получите персональный план развития городского проекта, основанный на методологии, которая работает в 40+ городах России.'),
        h('p', { class: 'hero__sub' },
          'Подходит и для идеи, и для уже работающего проекта: частным инициаторам, сообществам, бизнесу и НКО.'),
        h('ul', { class: 'benefits' },
          benefits.map(([t, d], i) => h('li', { class: 'benefit' },
            h('span', { class: 'benefit__num' }, String(i + 1).padStart(2, '0')),
            h('span', {}, h('b', {}, t), h('br'), d)))),
      ),
      h('div', { class: 'hero__form' },
        resume
          ? h('div', { class: 'card resume' },
              h('p', {}, `${state.name}, вы остановились на вопросе ${state.step + 1} из ${QUESTIONS.length}.`),
              h('div', { class: 'actions' },
                h('button', { class: 'btn btn--primary', onclick: () => renderQuestion() }, 'Продолжить'),
                h('button', { class: 'btn btn--ghost', onclick: () => { resetState(); renderIntro(); } }, 'Начать заново')))
          : form,
      ),
    ),
  );
  if (!resume) nameInput.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Экран 1: вопросы — по одному на экран
// ---------------------------------------------------------------------------

function isAnswered(q, a = state.answers) {
  const v = a[q.id];
  if (q.type === 'single') return Boolean(v) && (!q.options.find((o) => o.id === v)?.withText || Boolean(a[`${q.id}_other`]?.trim()));
  if (q.type === 'multi') return Array.isArray(v) && v.length > 0 && (!v.includes('other') || !q.options.find((o) => o.id === 'other')?.withText || Boolean(a[`${q.id}_other`]?.trim()));
  if (q.type === 'text') return typeof v === 'string' && v.trim().length >= (q.minLength || 1);
  if (q.type === 'matrix') return q.rows.every((r) => v?.[r.id]);
  return false;
}

function renderQuestion() {
  const i = Math.min(Math.max(state.step ?? 0, 0), QUESTIONS.length - 1);
  const q = QUESTIONS[i];
  const a = state.answers;
  const next = h('button', { class: 'btn btn--primary', type: 'button' }, i === QUESTIONS.length - 1 ? 'Получить результат' : 'Далее');
  const back = h('button', { class: 'btn btn--ghost', type: 'button', disabled: i === 0 }, 'Назад');
  const sync = () => { next.disabled = !isAnswered(q); saveState(); };

  let body;
  if (q.type === 'single' || q.type === 'multi') {
    const multi = q.type === 'multi';
    const otherOpt = q.options.find((o) => o.withText);
    const otherInput = otherOpt
      ? h('input', { type: 'text', class: 'other-input', maxlength: 200, placeholder: otherOpt.textPlaceholder ?? 'Ваш вариант', value: a[`${q.id}_other`] ?? '' })
      : null;
    const selected = () => (multi ? a[q.id] ?? [] : [a[q.id]]);
    const updateOther = () => {
      if (!otherInput) return;
      const show = selected().includes(otherOpt.id);
      otherInput.hidden = !show;
    };
    body = h('div', { class: `options ${q.options.length > 6 ? 'options--grid' : ''}` },
      q.options.map((o) => {
        const input = h('input', {
          type: multi ? 'checkbox' : 'radio',
          name: q.id,
          value: o.id,
          checked: selected().includes(o.id),
        });
        input.addEventListener('change', () => {
          if (multi) {
            let list = [...(a[q.id] ?? [])];
            if (input.checked) {
              list = o.exclusive ? [o.id] : [...list.filter((id) => !q.options.find((x) => x.id === id)?.exclusive), o.id];
            } else list = list.filter((id) => id !== o.id);
            a[q.id] = list;
            body.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = list.includes(cb.value)));
          } else {
            a[q.id] = o.id;
          }
          updateOther();
          if (otherInput && !otherInput.hidden && o.withText) otherInput.focus();
          sync();
          // Для одиночного выбора без доп. поля — сразу дальше
          if (!multi && !o.withText) setTimeout(() => isAnswered(q) && goNext(), 220);
        });
        return h('label', { class: `option ${multi ? 'option--multi' : ''}` }, input, h('span', { class: 'option__box' }), h('span', { class: 'option__label' }, o.label));
      }),
      otherInput,
    );
    if (otherInput) {
      otherInput.addEventListener('input', () => { a[`${q.id}_other`] = otherInput.value; sync(); });
      updateOther();
    }
  } else if (q.type === 'text') {
    const ta = h('textarea', { rows: 4, maxlength: q.maxLength, placeholder: q.placeholder });
    ta.value = a[q.id] ?? '';
    const counter = h('span', { class: 'counter' });
    const upd = () => { counter.textContent = `${ta.value.length} / ${q.maxLength}`; };
    ta.addEventListener('input', () => { a[q.id] = ta.value; upd(); sync(); });
    upd();
    body = h('div', { class: 'textarea-wrap' }, ta, counter);
    setTimeout(() => ta.focus(), 0);
  } else if (q.type === 'matrix') {
    a[q.id] = a[q.id] ?? {};
    body = h('div', { class: 'matrix' },
      q.rows.map((r) => h('div', { class: 'matrix__row' },
        h('span', { class: 'matrix__label' }, r.label),
        h('div', { class: 'matrix__choices' },
          q.columns.map((c) => {
            const input = h('input', { type: 'radio', name: `${q.id}-${r.id}`, value: c.id, checked: a[q.id][r.id] === c.id });
            input.addEventListener('change', () => { a[q.id][r.id] = c.id; sync(); });
            return h('label', { class: `pill pill--${c.id}` }, input, h('span', {}, c.label));
          })),
      )),
    );
  }

  const goNext = async () => {
    if (!isAnswered(q)) return;
    if (i < QUESTIONS.length - 1) {
      state.step = i + 1;
      saveState();
      api(`/api/progress/${state.id}`, { step: state.step }).catch(() => {});
      renderQuestion();
    } else {
      await submitAnswers(next);
    }
  };
  next.addEventListener('click', goNext);
  back.addEventListener('click', () => { state.step = i - 1; saveState(); renderQuestion(); });

  const pct = Math.round((i / QUESTIONS.length) * 100);
  render(
    h('section', { class: 'quiz' },
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { class: 'progress__meta' },
          h('span', {}, BLOCKS[q.block]),
          h('span', {}, `Вопрос ${i + 1} из ${QUESTIONS.length}`)),
        h('div', { class: 'progress__bar' }, h('div', { class: 'progress__fill', style: `width:${pct}%` }))),
      h('div', { class: 'card question' },
        h('h2', { class: 'question__title' }, q.title),
        q.hint ? h('p', { class: 'question__hint' }, q.hint) : null,
        body,
        h('div', { class: 'actions actions--quiz' }, back, next)),
    ),
  );
  sync();
}

async function submitAnswers(btn) {
  btn.disabled = true;
  btn.textContent = 'Считаем результат…';
  try {
    const data = await api(`/api/submit/${state.id}`, { answers: state.answers });
    const id = state.id;
    state = { done: true, lastResultId: id };
    saveState();
    history.pushState({}, '', `/r/${id}`);
    renderResult(data, { personalize: true });
  } catch (err) {
    if (err.status === 404) {
      alert('Сессия диагностики не найдена. Пожалуйста, начните заново.');
      resetState();
      renderIntro();
      return;
    }
    const missing = err.data?.errors?.[0];
    if (missing) {
      state.step = QUESTIONS.findIndex((q) => q.id === missing);
      saveState();
      renderQuestion();
      return;
    }
    alert('Не удалось получить результат. Проверьте соединение и попробуйте ещё раз.');
    btn.disabled = false;
    btn.textContent = 'Получить результат';
  }
}

// ---------------------------------------------------------------------------
// Экран 2: результат + роадмап + CTA
// ---------------------------------------------------------------------------

function renderResult({ id, name, result }, { personalize = false } = {}) {
  const r = result;
  const loading = personalize && config.aiEnabled && !r.personalized;
  const pct = Math.round((r.total / r.max) * 100);
  const firstName = (name || '').split(/\s+/)[0];

  const scoreCard = h('section', { class: 'card result-head' },
    h('p', { class: 'eyebrow' }, firstName ? `${firstName}, ваш результат` : 'Ваш результат'),
    h('div', { class: 'score' },
      h('div', { class: 'score__ring', style: `--p:${pct}` },
        h('span', { class: 'score__num' }, fmt(r.total)),
        h('span', { class: 'score__max' }, `из ${r.max}`)),
      h('div', { class: 'score__text' },
        h('h1', { class: 'result-title' }, `Ваш проект: ${fmt(r.total)} из ${r.max} баллов`),
        h('p', { class: 'result-stage' }, r.resultStage.text))),
    h('dl', { class: 'facts' },
      h('div', {}, h('dt', {}, 'Формат'), h('dd', {}, [r.format, r.audience ? `для: ${r.audience}` : null].filter(Boolean).join(' · '))),
      h('div', {}, h('dt', {}, 'Стадия'), h('dd', {}, r.stage.label)),
      h('div', {}, h('dt', {}, 'Ваш проект'), h('dd', { class: 'quote' }, `«${r.problem}»`)),
    ),
  );

  const loader = (label) => h('div', { class: 'ai-loading' }, h('span', { class: 'spinner' }), label);

  const listSection = (title, items, kind) =>
    h('section', { class: `card block block--${kind}` },
      h('h2', { class: 'block__title' }, title),
      items.length
        ? h('ol', { class: 'items' },
            items.map((it) => h('li', { class: 'item' },
              h('div', { class: 'item__head' },
                h('h3', {}, it.title),
                h('span', { class: `badge badge--${kind}` }, `${fmt(it.score)}/${it.max}`)),
              h('p', { 'data-text': `${kind}-${it.id}` }, it.text))))
        : h('p', { class: 'muted' },
            kind === 'strength'
              ? 'Пока ни один показатель не набрал максимального балла — это нормально для проекта на ранней стадии. Сильные стороны появятся по мере того, как вы будете проверять идею на практике.'
              : 'По всем показателям диагностики у проекта максимальный балл. Фокус — на развитии и масштабе.'),
    );

  const potential = h('section', { class: 'card block' },
    h('h2', { class: 'block__title' }, 'Потенциал развития'),
    h('p', { 'data-text': 'potential' }, r.potential));

  const nextStep = h('section', { class: 'card block block--accent' },
    h('h2', { class: 'block__title' }, 'Ваш ближайший шаг'),
    h('p', { class: 'next-step', 'data-text': 'next' }, r.nextStep));

  const roadmapList = h('ol', { class: 'roadmap' });
  const fillRoadmap = (steps) => roadmapList.replaceChildren(
    ...steps.map((s, idx) => h('li', { class: 'roadmap__step' },
      h('span', { class: 'roadmap__num' }, String(idx + 1)),
      h('div', {}, h('h3', {}, s.title), s.text ? h('p', {}, s.text) : null))));
  fillRoadmap(r.roadmap);
  const roadmap = h('section', { class: 'card block' },
    h('h2', { class: 'block__title' }, 'Роадмап на год'),
    h('p', { class: 'muted' }, 'Шаги, которые реально сделать в течение года — с учётом стадии проекта, результатов диагностики и вашего запроса.'),
    roadmapList);

  const profile = h('details', { class: 'card profile' },
    h('summary', {}, 'Подробный профиль показателей'),
    h('ul', { class: 'bars' },
      r.scores.map((s) => h('li', { class: 'bar' },
        h('span', { class: 'bar__name' }, s.name),
        h('span', { class: 'bar__track' }, h('span', { class: 'bar__fill', style: `width:${(s.score / s.max) * 100}%` })),
        h('span', { class: 'bar__val' }, `${fmt(s.score)}/${s.max}`)))));

  const track = (type) => () => {
    try {
      const body = JSON.stringify({ type });
      navigator.sendBeacon?.(`/api/cta/${id}`, new Blob([body], { type: 'application/json' })) ||
        fetch(`/api/cta/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    } catch { /* аналитика не должна мешать переходу */ }
  };

  const cta = h('section', { class: 'cta' },
    h('h2', {}, 'Разберём ваш проект вместе'),
    h('p', {}, 'Эксперты Городского университета 2.0 помогут превратить роадмап в план действий, а Школа городских продюсеров — пройти путь от идеи до работающего городского продукта.'),
    h('div', { class: 'cta__buttons' },
      h('a', { class: 'btn btn--primary btn--lg', href: config.consultationUrl, target: '_blank', rel: 'noopener', onclick: track('consultation') },
        'Записаться на бесплатную консультацию экспертов ГУ 2.0 по вашему проекту — 30 минут'),
      h('a', { class: 'btn btn--light btn--lg', href: config.schoolUrl, target: '_blank', rel: 'noopener', onclick: track('school') },
        'Записаться в Школу городских продюсеров')),
  );

  const tools = h('div', { class: 'result-tools' },
    h('button', { class: 'btn btn--ghost', onclick: () => window.print() }, 'Сохранить PDF / распечатать'),
    h('button', {
      class: 'btn btn--ghost',
      onclick: async (e) => {
        const url = `${location.origin}/r/${id}`;
        try { await navigator.clipboard.writeText(url); e.target.textContent = 'Ссылка скопирована'; }
        catch { prompt('Ссылка на результат:', url); }
      },
    }, 'Скопировать ссылку'),
    h('button', { class: 'btn btn--ghost', onclick: () => { resetState(); history.pushState({}, '', '/'); renderIntro(); } }, 'Пройти заново'),
  );

  const banner = loading ? loader('Готовим персональные рекомендации и роадмап под ваш проект…') : null;

  render(
    h('div', { class: 'result' },
      scoreCard,
      banner,
      h('div', { class: 'grid-2' },
        listSection('Что сейчас уже хорошо получается', r.strengths, 'strength'),
        listSection('Что сейчас стоит развивать', r.growthZones, 'growth')),
      potential,
      nextStep,
      roadmap,
      profile,
      cta,
      tools,
    ),
  );

  if (loading) {
    [potential, nextStep, roadmap].forEach((el) => el.classList.add('is-loading'));
    api(`/api/personalize/${id}`, {})
      .then(({ result: pr }) => {
        if (!pr?.personalized) return;
        for (const it of pr.strengths) app.querySelector(`[data-text="strength-${it.id}"]`)?.replaceChildren(it.text);
        for (const it of pr.growthZones) app.querySelector(`[data-text="growth-${it.id}"]`)?.replaceChildren(it.text);
        app.querySelector('[data-text="potential"]')?.replaceChildren(pr.potential);
        app.querySelector('[data-text="next"]')?.replaceChildren(pr.nextStep);
        fillRoadmap(pr.roadmap);
        if (pr.problemUnclear) {
          app.querySelector('.quote')?.after(h('span', { class: 'hint-inline' }, 'Совет: попробуйте сформулировать проблему конкретнее — для кого она существует, где проявляется и что именно происходит.'));
        }
      })
      .catch(() => {})
      .finally(() => {
        banner?.remove();
        [potential, nextStep, roadmap].forEach((el) => el.classList.remove('is-loading'));
      });
  }
}

// ---------------------------------------------------------------------------
// Роутинг
// ---------------------------------------------------------------------------

async function route() {
  const m = location.pathname.match(/^\/r\/([\w-]+)$/);
  if (m) {
    render(h('div', { class: 'card center' }, h('span', { class: 'spinner' }), ' Загружаем результат…'));
    try {
      const data = await api(`/api/result/${m[1]}`);
      renderResult(data, { personalize: !data.result.personalized });
    } catch {
      render(h('div', { class: 'card center' },
        h('h2', {}, 'Результат не найден'),
        h('p', {}, 'Возможно, ссылка устарела. Пройдите диагностику ещё раз — это займёт 7 минут.'),
        h('a', { class: 'btn btn--primary', href: '/' }, 'Пройти диагностику')));
    }
    return;
  }
  if (state.id && state.step != null && !state.done && location.hash === '#q') renderQuestion();
  else renderIntro();
}

window.addEventListener('popstate', route);

(async () => {
  try { config = await api('/api/config'); } catch { /* значения по умолчанию */ }
  route();
})();
