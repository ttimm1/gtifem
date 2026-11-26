/* ============================================================
   ФЭМ · Расписание — логика Mini App
   Без сборки и зависимостей: чистый JS + fetch.
   ============================================================ */
(() => {
  'use strict';

  const splashStart = Date.now();
  const CONFIG = window.FEM_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const LS = {
    group: 'fem:group',
    theme: 'fem:theme',
    palette: 'fem:palette',
    sched: (id) => 'fem:sched:' + id,
    catalog: 'fem:catalog',
  };

  const PALETTES = [
    { id: 'ocean', name: 'Океан', accent: '#2F63E8', accent2: '#7FA8FF', a: '#06101F', b: '#1E49C8' },
    { id: 'crimson', name: 'Академия', accent: '#E4002B', accent2: '#FF6B7F', a: '#1C0408', b: '#B3001F' },
    { id: 'emerald', name: 'Изумруд', accent: '#0E9F6E', accent2: '#4ADE9E', a: '#04251C', b: '#0A7A57' },
    { id: 'violet', name: 'Лаванда', accent: '#7457F5', accent2: '#B39DFF', a: '#171033', b: '#4B2FC7' },
    { id: 'sunset', name: 'Закат', accent: '#E85D33', accent2: '#FFA36B', a: '#2A0E08', b: '#C2411F' },
    { id: 'rose', name: 'Роза', accent: '#D93E79', accent2: '#FF8FB4', a: '#290A17', b: '#AE2455' },
    { id: 'gold', name: 'Золото', accent: '#B07A1A', accent2: '#F2C14E', a: '#231803', b: '#855B0E' },
    { id: 'graphite', name: 'Графит', accent: '#5B6B84', accent2: '#A3B0C2', a: '#0A0D12', b: '#364355' },
  ];

  const PROGRAMS = ['Все', 'Бакалавриат', 'Магистратура', 'СПО'];
  const WD_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const WD_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTH_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  const state = {
    tab: 'today',
    theme: 'auto',
    paletteId: 'ocean',
    groupId: null,
    catalog: null,
    schedule: null,
    weekOffset: 0,
    weekSelected: null,
    weekMode: 'day',
    cal: null,
    calSelected: null,
    program: 'Все',
    query: '',
    loading: true,
    error: null,
    updated: null,
    subscribed: localStorage.getItem('fem:subscribed') === '1',
  };

  /* ---------- утилиты ---------- */

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  let DEBUG_NOW = null;

  function mskNow() {
    if (DEBUG_NOW) return new Date(DEBUG_NOW);
    try {
      const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
      const d = new Date(s.replace(' ', 'T'));
      if (!isNaN(d)) return d;
    } catch (_) { /* ignore */ }
    return new Date();
  }

  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function minOf(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b === 1) return forms[0];
    if (b >= 2 && b <= 4) return forms[1];
    return forms[2];
  }

  const lessonsWord = (n) => plural(n, ['пара', 'пары', 'пар']);
  const minutesWord = (n) => plural(n, ['минута', 'минуты', 'минут']);

  function countdown(mins) {
    if (mins < 1) return 'меньше минуты';
    if (mins < 60) return `${mins} ${minutesWord(mins)}`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }

  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function dayOfSchedule(dateISO) {
    return (state.schedule?.days || []).find((d) => d.date === dateISO) || null;
  }

  function greeting(d) {
    const h = d.getHours();
    if (h >= 5 && h < 12) return 'Доброе утро';
    if (h >= 12 && h < 18) return 'Добрый день';
    if (h >= 18 && h < 23) return 'Добрый вечер';
    return 'Доброй ночи';
  }

  function typeInfo(type) {
    const t = (type || '').toLowerCase();
    if (t === 'лек') return { cls: 'lec', label: 'лекция' };
    if (t === 'пр') return { cls: 'prac', label: 'практика' };
    if (t === 'лаб') return { cls: 'lab', label: 'лаборатория' };
    if (t === 'зач' || t === 'экз') return { cls: 'exam', label: t === 'зач' ? 'зачёт' : 'экзамен' };
    return null;
  }

  function hideSplash(minMs = 1150) {
    const wait = Math.max(0, minMs - (Date.now() - splashStart));
    setTimeout(() => {
      const el = document.getElementById('splash');
      if (!el) return;
      el.classList.add('done');
      setTimeout(() => el.remove(), 520);
    }, wait);
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function haptic(kind = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(kind); } catch (_) { /* noop */ }
  }

  /* ---------- настройки ---------- */

  function hex2rgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function mixHex(a, b, t) {
    const A = hex2rgb(a);
    const B = hex2rgb(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }

  function isDarkMode() {
    return state.theme === 'dark' || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** На тёмном фоне акцент чуть светлее — иначе синий «тонет». */
  function syncAccent() {
    const p = PALETTES.find((x) => x.id === state.paletteId) || PALETTES[0];
    const r = document.documentElement.style;
    r.setProperty('--accent', isDarkMode() ? mixHex(p.accent, '#FFFFFF', 0.2) : p.accent);
    r.setProperty('--accent-2', p.accent2);
  }

  function applyPalette(id, persist = true) {
    const p = PALETTES.find((x) => x.id === id) || PALETTES[0];
    state.paletteId = p.id;
    const r = document.documentElement.style;
    r.setProperty('--accent', p.accent);
    r.setProperty('--accent-2', p.accent2);
    r.setProperty('--hero-a', p.a);
    r.setProperty('--hero-b', p.b);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', p.a);
    if (persist) localStorage.setItem(LS.palette, p.id);
    syncAccent();
  }

  function applyTheme(mode, persist = true) {
    state.theme = mode;
    document.documentElement.dataset.theme = mode;
    if (persist) localStorage.setItem(LS.theme, mode);
    syncAccent();
    syncTelegramChrome();
  }

  function syncTelegramChrome() {
    if (!tg) return;
    try {
      const dark = state.theme === 'dark' || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
      tg.setHeaderColor(dark ? '#0A090C' : '#F4F1EE');
      tg.setBackgroundColor(dark ? '#0A090C' : '#F4F1EE');
    } catch (_) { /* noop */ }
  }

  /* ---------- данные ---------- */

  async function fetchJSON(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(path, { cache: opts.fresh ? 'no-store' : 'default', signal: ctrl.signal });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadCatalog(force = false) {
    if (state.catalog && !force) return state.catalog;
    try {
      const data = await fetchJSON('data/catalog.json?t=' + (force ? Date.now() : Math.floor(Date.now() / 600000)), { fresh: force });
      state.catalog = data;
      state.updated = data.updated;
      localStorage.setItem(LS.catalog, JSON.stringify({ t: Date.now(), d: data }));
      return data;
    } catch (err) {
      const cached = localStorage.getItem(LS.catalog);
      if (cached) {
        try {
          const { d } = JSON.parse(cached);
          state.catalog = d;
          state.updated = d.updated;
          return d;
        } catch (_) { /* ignore */ }
      }
      throw err;
    }
  }

  function slug(id) { return String(id).replace(/,/g, '-'); }

  async function loadSchedule(groupId, force = false) {
    if (!groupId) return null;
    if (state.schedule && state.schedule.group === groupId && !force) return state.schedule;
    const key = LS.sched(groupId);
    const cached = localStorage.getItem(key);
    try {
      const data = await fetchJSON(`data/schedule/${slug(groupId)}.json`, { fresh: force });
      state.schedule = data;
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
      return data;
    } catch (err) {
      if (cached) {
        try {
          const { d } = JSON.parse(cached);
          state.schedule = d;
          toast('Нет сети — показываю сохранённое');
          return d;
        } catch (_) { /* ignore */ }
      }
      throw err;
    }
  }

  function groupInfo(id) {
    return (state.catalog?.groups || []).find((g) => g.id === id) || null;
  }

  function setGroup(id) {
    state.groupId = id;
    localStorage.setItem(LS.group, id);
    state.schedule = null;
    state.weekOffset = 0;
    state.weekSelected = null;
    state.cal = null;
    state.calSelected = null;
    try { tg?.CloudStorage?.setItem('group', id, () => {}); } catch (_) { /* noop */ }
    if (state.subscribed) apiSubscribe(true, true);
    renderAllScreens();
  }

  /* ---------- герой ---------- */

  function heroLessonCard(day, now, nowMin) {
    const lessons = day?.lessons || [];
    let current = null;
    let next = null;
    for (const l of lessons) {
      const s = minOf(l.start);
      const e = minOf(l.end);
      if (nowMin >= s && nowMin < e) current = l;
      else if (s > nowMin && !next) next = l;
    }
    const date = day ? parseISO(day.date) : null;
    const dateLabel = date ? `${WD_FULL[(date.getDay() + 6) % 7]} · ${date.getDate()} ${MONTH_GEN[date.getMonth()]}` : '';

    if (!lessons.length) return null;

    if (current) {
      const s = minOf(current.start);
      const e = minOf(current.end);
      const pct = Math.max(3, Math.min(100, ((nowMin - s) / (e - s)) * 100));
      return `
        <div class="bubble b1"></div><div class="bubble b2"></div>
        <div class="hero-top">
          <span class="hero-date">${esc(dateLabel)}</span>
          <span class="hero-state"><span class="dot"></span>сейчас идёт</span>
        </div>
        <h1 class="hero-subject${current.subject.length > 34 ? ' small' : ''}">${esc(current.subject)}</h1>
        <div class="hero-meta">
          <span class="m"><svg class="ic"><use href="#i-clock"/></svg><b>${esc(current.time)}</b></span>
          ${current.room ? `<span class="m"><svg class="ic"><use href="#i-pin"/></svg>ауд. ${esc(current.room)}</span>` : ''}
          ${current.teacher ? `<span class="m"><svg class="ic"><use href="#i-person"/></svg>${esc(current.teacher)}</span>` : ''}
        </div>
        <div class="hero-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="hero-foot">
          <span>до конца ${countdown(e - nowMin)}</span>
          <span>пара ${lessons.indexOf(current) + 1} из ${lessons.length}</span>
        </div>`;
    }

    if (next) {
      const s = minOf(next.start);
      return `
        <div class="bubble b1"></div><div class="bubble b2"></div>
        <div class="hero-top">
          <span class="hero-date">${esc(dateLabel)}</span>
          <span class="hero-state is-next"><span class="dot"></span>через ${countdown(s - nowMin)}</span>
        </div>
        <h1 class="hero-subject${next.subject.length > 34 ? ' small' : ''}">${esc(next.subject)}</h1>
        <div class="hero-meta">
          <span class="m"><svg class="ic"><use href="#i-clock"/></svg><b>${esc(next.time)}</b></span>
          ${next.room ? `<span class="m"><svg class="ic"><use href="#i-pin"/></svg>ауд. ${esc(next.room)}</span>` : ''}
          ${next.teacher ? `<span class="m"><svg class="ic"><use href="#i-person"/></svg>${esc(next.teacher)}</span>` : ''}
        </div>
        <div class="hero-foot" style="margin-top:14px">
          <span>${greeting(now)}, сегодня ещё ${lessons.length - lessons.indexOf(next)} ${lessonsWord(lessons.length - lessons.indexOf(next))}</span>
          <span>${esc(next.start)}</span>
        </div>`;
    }

    return `
      <div class="bubble b1"></div><div class="bubble b2"></div>
      <div class="hero-top">
        <span class="hero-date">${esc(dateLabel)}</span>
        <span class="hero-state is-free"><span class="dot"></span>на сегодня всё</span>
      </div>
      <h1 class="hero-subject">Пары закончились</h1>
      <div class="hero-meta"><span class="m">Хорошего вечера — до завтра.</span></div>
      <div class="hero-foot" style="margin-top:14px">
        <span>сегодня было ${lessons.length} ${lessonsWord(lessons.length)}</span>
        <span>${esc(lessons[lessons.length - 1].end)}</span>
      </div>`;
  }

  /** Список пар одного дня: вертикальный таймлайн с рельсом времени. */
  function timelineHTML(lessons, nowMin, isToday) {
    return lessons.map((l, i) => {
      const s = minOf(l.start);
      const e = minOf(l.end);
      const cls = isToday ? (nowMin >= e ? 'past' : nowMin >= s && nowMin < e ? 'now' : '') : '';
      const ti = typeInfo(l.type);
      return `
        <div class="lesson ${cls}" style="--i:${i}">
          <div class="rail"><time>${esc(l.start)}</time><em>${esc(l.end)}</em></div>
          <div class="lesson-body">
            ${cls === 'now' ? '<span class="lesson-flag">сейчас</span>' : ''}
            <div class="lesson-subject">${esc(l.subject)}</div>
            <div class="lesson-meta">
              ${ti ? `<span class="badge ${ti.cls}">${ti.label}</span>` : ''}
              ${l.room ? `<span class="m"><svg class="ic"><use href="#i-pin"/></svg>${esc(l.room)}</span>` : ''}
              ${l.teacher ? `<span class="m"><svg class="ic"><use href="#i-person"/></svg>${esc(l.teacher)}</span>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderToday() {
    const body = $('#todayBody');
    if (state.loading) {
      body.innerHTML = `<div class="skeleton" style="height:180px"></div>` + '<div class="skeleton"></div>'.repeat(3);
      return;
    }
    if (!state.groupId) {
      body.innerHTML = `
        <section class="hero">
          <div class="bubble b1"></div><div class="bubble b2"></div>
          <div class="hero-top"><span class="hero-date">ФЭМ · СПбГТИ(ТУ)</span><span class="hero-state"><span class="dot"></span>расписание</span></div>
          <h1 class="hero-subject">Твоё расписание</h1>
          <div class="hero-meta"><span class="m">Выбери группу — покажу пары на сегодня, на неделю и на весь семестр.</span></div>
          <button class="hero-cta" id="onboardBtn">Выбрать группу</button>
        </section>
        <div class="section-title"><h2>Что внутри</h2></div>
        <div class="onboard-list">
          <div class="onboard-item"><b>1</b><div><strong>Группа — один раз</strong><span>Дальше приложение помнит её само.</span></div></div>
          <div class="onboard-item"><b>2</b><div><strong>Пары и календарь</strong><span>Сегодня, вся неделя и семестр.</span></div></div>
          <div class="onboard-item"><b>3</b><div><strong>Картинка для друзей</strong><span>Расписание можно отправить одним касанием.</span></div></div>
        </div>`;
      $('#onboardBtn').addEventListener('click', openPicker);
      return;
    }
    if (state.error) {
      body.innerHTML = `<div class="empty"><div class="big">📡</div><h3>Не удалось загрузить</h3><p>${esc(state.error)}</p><button id="retryBtn">Попробовать снова</button></div>`;
      $('#retryBtn').addEventListener('click', () => init(true));
      return;
    }

    const now = mskNow();
    const todayISO = iso(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let day = dayOfSchedule(todayISO);
    let hero = heroLessonCard(day, now, nowMin);

    if (!hero) {
      // сегодня пар нет — показываем ближайший день
      const upNext = (state.schedule?.days || []).find((d) => d.date > todayISO);
      if (upNext) {
        const d = parseISO(upNext.date);
        const n = upNext.lessons[0];
        const when = d.getDate() === addDays(now, 1).getDate() && d.getMonth() === addDays(now, 1).getMonth() ? 'завтра' : `${WD_FULL[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTH_GEN[d.getMonth()]}`;
        hero = `
          <div class="bubble b1"></div><div class="bubble b2"></div>
          <div class="hero-top"><span class="hero-date">${esc(WD_FULL[(now.getDay() + 6) % 7] + ' · ' + now.getDate() + ' ' + MONTH_GEN[now.getMonth()])}</span><span class="hero-state is-free"><span class="dot"></span>пар нет</span></div>
          <h1 class="hero-subject">Сегодня пар нет</h1>
          <div class="hero-meta"><span class="m">Ближайшая — <b>${esc(when)}</b> в ${esc(n.start)}</span></div>
          <div class="hero-foot" style="margin-top:14px"><span>${esc(n.subject)}</span><span>${esc(n.room ? 'ауд. ' + n.room : '')}</span></div>`;
      } else {
        hero = `
          <div class="bubble b1"></div><div class="bubble b2"></div>
          <div class="hero-top"><span class="hero-date">${esc(WD_FULL[(now.getDay() + 6) % 7] + ' · ' + now.getDate() + ' ' + MONTH_GEN[now.getMonth()])}</span><span class="hero-state is-free"><span class="dot"></span>пар нет</span></div>
          <h1 class="hero-subject">Свободный день</h1>
          <div class="hero-meta"><span class="m">Расписание на этот день не опубликовано.</span></div>`;
      }
    }

    const lessons = day?.lessons || [];
    const listHTML = lessons.length
      ? timelineHTML(lessons, nowMin, true)
      : `<div class="empty"><div class="big">☕️</div><h3>Сегодня пар нет</h3><p>Отдыхай — или загляни на вкладку «Неделя».</p></div>`;

    body.innerHTML = `
      <section class="hero">${hero}</section>
      <div class="section-title">
        <h2>${lessons.length ? 'Сегодня' : 'Ближайшее'}</h2>
        <span>${lessons.length ? lessons.length + ' ' + lessonsWord(lessons.length) : ''}</span>
      </div>
      <div class="day-list">${listHTML}</div>
      ${lessons.length ? `<button class="share-cta" data-share="day"><svg class="ic"><use href="#i-share"/></svg>Поделиться картинкой</button>` : ''}`;
  }

  /* ---------- неделя ---------- */

  function renderWeek() {
    const now = mskNow();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const monday = addDays(startOfWeek(now), state.weekOffset * 7);
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const sunday = weekDays[6];
    const todayISO = iso(now);
    const inWeek = weekDays.some((d) => iso(d) === todayISO);

    $('#weekTitle').textContent = monday.getMonth() === sunday.getMonth()
      ? `${monday.getDate()} – ${sunday.getDate()} ${MONTH_GEN[sunday.getMonth()]}`
      : `${monday.getDate()} ${MONTH_GEN[monday.getMonth()].slice(0, 3)} – ${sunday.getDate()} ${MONTH_GEN[sunday.getMonth()].slice(0, 3)}`;

    const has = (d) => (dayOfSchedule(iso(d))?.lessons?.length || 0) > 0;

    // Если выбранный день не из этой недели — показываем сегодня или понедельник.
    let selISO = state.weekSelected;
    if (!selISO || !weekDays.some((d) => iso(d) === selISO)) {
      selISO = inWeek ? todayISO : iso(monday);
    }
    state.weekSelected = selISO;

    $('#dayStrip').innerHTML = weekDays.map((d, i) => {
      const id = iso(d);
      const classes = ['day-pill'];
      if (has(d)) classes.push('has');
      if (id === todayISO) classes.push('today');
      if (id === selISO) classes.push('sel');
      if (!has(d)) classes.push('off');
      return `<button class="${classes.join(' ')}" data-day="${id}">
        <span class="wd">${WD_SHORT[i]}</span>
        <span class="dn">${d.getDate()}</span>
        <span class="dot"></span>
      </button>`;
    }).join('');

    const selDate = parseISO(selISO);
    const selDay = dayOfSchedule(selISO);
    const selLessons = selDay?.lessons || [];
    const isToday = selISO === todayISO;
    const label = `${WD_FULL[(selDate.getDay() + 6) % 7].replace(/^./, (c) => c.toUpperCase())}, ${selDate.getDate()} ${MONTH_GEN[selDate.getMonth()]}`;

    const toggle = `<div class="week-sub">
      <span class="ws-day"><b>${label}</b>${selLessons.length ? ` · ${selLessons.length} ${lessonsWord(selLessons.length)}` : ''}</span>
      <div class="ws-actions">
        <button class="ws-share" data-share="${state.weekMode === 'week' ? 'week' : 'day'}" aria-label="Поделиться расписанием">
          <svg class="ic"><use href="#i-share"/></svg>
        </button>
        <button id="weekModeBtn">${state.weekMode === 'week' ? 'по дням' : 'вся неделя'}</button>
      </div>
    </div>`;

    if (state.weekMode === 'week') {
      $('#weekBody').innerHTML = toggle + weekDays.map((d) => {
        const id = iso(d);
        const day = dayOfSchedule(id);
        const lessons = day?.lessons || [];
        const dayIsToday = id === todayISO;
        const head = `<div class="week-day-head clickable" data-goday="${id}">
          <h3>${WD_FULL[(d.getDay() + 6) % 7].replace(/^./, (c) => c.toUpperCase())} <span class="num">${d.getDate()} ${MONTH_GEN[d.getMonth()]}</span></h3>
          <span class="cnt">${lessons.length ? lessons.length + ' ' + lessonsWord(lessons.length) : '—'}</span>
        </div>`;
        const rows = lessons.length
          ? `<div class="compact">${lessons.map((l) => {
              const ti = typeInfo(l.type);
              return `<div class="crow">
                <div><div class="ct">${esc(l.start)}</div><div class="cd">${esc(l.end)}</div></div>
                <div><div class="cs">${esc(l.subject)}</div><div class="cd">${[l.room ? 'ауд. ' + l.room : '', l.teacher].filter(Boolean).map(esc).join(' · ')}</div></div>
                ${ti ? `<span class="badge ${ti.cls}">${ti.label}</span>` : '<span></span>'}
              </div>`;
            }).join('')}</div>`
          : `<div class="day-free">${dayIsToday ? 'Сегодня пар нет' : 'Пар нет'}</div>`;
        return `<section class="week-day${dayIsToday ? ' today' : ''}" id="wd-${id}">${head}${rows}</section>`;
      }).join('');
    } else {
      $('#weekBody').innerHTML = toggle + (selLessons.length
        ? `<div class="day-list">${timelineHTML(selLessons, nowMin, isToday)}</div>`
        : `<div class="empty"><div class="big">${isToday ? '☕️' : '🌤'}</div><h3>${isToday ? 'Сегодня пар нет' : 'Пар нет'}</h3><p>Выбери другой день в полоске выше — или загляни в «Всё».</p></div>`);
    }

    $('#weekModeBtn')?.addEventListener('click', () => {
      state.weekMode = state.weekMode === 'week' ? 'day' : 'week';
      renderWeek();
      haptic('light');
    });
  }

  /* ---------- всё / календарь ---------- */

  function scheduleMonths() {
    const set = new Set();
    for (const d of state.schedule?.days || []) set.add(d.date.slice(0, 7));
    return [...set].sort();
  }

  function ensureCal() {
    const now = mskNow();
    if (!state.cal) state.cal = { y: now.getFullYear(), m: now.getMonth() };
    if (!state.calSelected) {
      const todayKey = iso(now);
      const hasToday = !!dayOfSchedule(todayKey);
      const monthKey = `${state.cal.y}-${pad(state.cal.m + 1)}`;
      const first = (state.schedule?.days || []).find((d) => d.date.startsWith(monthKey));
      state.calSelected = hasToday ? todayKey : first?.date || todayKey;
    }
  }

  function renderAll() {
    ensureCal();
    const { y, m } = state.cal;
    $('#calTitle').textContent = `${MONTH_NOM[m]} ${y}`;

    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const dim = new Date(y, m + 1, 0).getDate();
    const todayISO = iso(mskNow());
    const months = scheduleMonths();
    const monthKey = `${y}-${pad(m + 1)}`;

    $('#calPrev').style.opacity = months.length && monthKey <= months[0] ? '.3' : '1';
    $('#calNext').style.opacity = months.length && monthKey >= months[months.length - 1] ? '.3' : '1';

    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<div class="cal-cell blank"></div>';
    for (let d = 1; d <= dim; d++) {
      const id = `${y}-${pad(m + 1)}-${pad(d)}`;
      const has = !!dayOfSchedule(id);
      const cls = ['cal-cell'];
      if (has) cls.push('has');
      if (id === todayISO) cls.push('today');
      if (id === state.calSelected) cls.push('sel');
      cells += `<button class="${cls.join(' ')}" data-date="${id}"><span class="n">${d}</span><span class="d"></span></button>`;
    }

    const wd = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    $('#calendar').innerHTML = `<div class="cal-wd">${wd.map((w) => `<span>${w}</span>`).join('')}</div><div class="cal-grid">${cells}</div>`;

    const sel = state.calSelected;
    const day = dayOfSchedule(sel);
    const date = sel ? parseISO(sel) : null;
    const head = date
      ? `<div class="cal-dayhead"><h3>${WD_FULL[(date.getDay() + 6) % 7]}, ${date.getDate()} ${MONTH_GEN[date.getMonth()]}</h3><span>${day ? day.lessons.length + ' ' + lessonsWord(day.lessons.length) : 'пар нет'}</span></div>`
      : '';
    const body = day?.lessons?.length
      ? `<div class="compact">${day.lessons.map((l) => {
          const ti = typeInfo(l.type);
          return `<div class="crow">
            <div><div class="ct">${esc(l.start)}</div><div class="cd">${esc(l.end)}</div></div>
            <div><div class="cs">${esc(l.subject)}</div><div class="cd">${[l.room ? 'ауд. ' + l.room : '', l.teacher].filter(Boolean).map(esc).join(' · ')}</div></div>
            ${ti ? `<span class="badge ${ti.cls}">${ti.label}</span>` : '<span></span>'}
          </div>`;
        }).join('')}</div>`
      : `<div class="empty"><div class="big">🗓</div><h3>Пар нет</h3><p>${state.schedule ? 'В этот день занятий не стоит.' : 'Выберите группу, чтобы увидеть расписание.'}</p></div>`;

    const shareBtn = day?.lessons?.length
      ? `<button class="share-cta" data-share="day" data-day="${sel}"><svg class="ic"><use href="#i-share"/></svg>Поделиться картинкой</button>`
      : '';
    $('#calBody').innerHTML = head + body + shareBtn;
  }

  /* ---------- ещё ---------- */

  function renderMore() {
    const g = groupInfo(state.groupId);
    const updated = state.updated ? fmtUpdated(state.updated) : '—';
    const lessonCount = (state.schedule?.days || []).reduce((n, d) => n + d.lessons.length, 0);

    $('#moreBody').innerHTML = `
      ${g ? `<section class="profile">
        <div class="eyebrow">${esc(g.program)} · ${g.course} курс</div>
        <h2>${esc(g.name)}</h2>
        <p>${esc(g.speciality)}</p>
        <div class="pstat">
          <div><b>${lessonCount}</b>пар в семестре</div>
          <div><b>${(state.schedule?.days || []).length}</b>учебных дней</div>
        </div>
      </section>` : `<section class="profile"><div class="eyebrow">ФЭМ · СПбГТИ(ТУ)</div><h2>Расписание</h2><p>Группа не выбрана</p></section>`}

      <div class="settings">
        <div class="set-group">
          <h4>Расписание</h4>
          <div class="set-card">
            <button class="set-row" id="changeGroup">
              <span class="si"><svg class="ic"><use href="#i-all"/></svg></span>
              <span class="st"><b>Группа</b><small>${g ? esc(g.speciality) : 'не выбрана'}</small></span>
              <span class="sv">${g ? esc(g.name) : 'выбрать'}</span>
              <svg class="ic ic-chev"><use href="#i-chevron"/></svg>
            </button>
            <button class="set-row" id="notifyRow">
              <span class="si"><svg class="ic"><use href="#i-bell"/></svg></span>
              <span class="st"><b>Напоминания в боте</b><small>${state.subscribed ? 'Каждое утро в 8:00' : 'Утренняя сводка пар в Telegram'}</small></span>
              <span class="sv" style="${state.subscribed ? 'color:var(--accent);font-weight:650' : ''}">${state.subscribed ? 'вкл' : 'выкл'}</span>
            </button>
          </div>
        </div>

        <div class="set-group">
          <h4>Оформление</h4>
          <div class="set-card">
            <div class="set-row" style="display:block">
              <div class="segmented" id="themeSeg" style="margin:2px 0 10px">
                <button data-theme="auto" class="${state.theme === 'auto' ? 'on' : ''}">Авто</button>
                <button data-theme="light" class="${state.theme === 'light' ? 'on' : ''}">Светлая</button>
                <button data-theme="dark" class="${state.theme === 'dark' ? 'on' : ''}">Тёмная</button>
              </div>
              <div class="palettes" style="padding:2px 0 2px">
                ${PALETTES.map((p) => `<button class="pal ${p.id === state.paletteId ? 'on' : ''}" data-pal="${p.id}" title="${p.name}" style="background:linear-gradient(140deg,${p.accent},${p.b})">
                  ${p.id === state.paletteId ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : ''}
                </button>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="set-group">
          <h4>Данные</h4>
          <div class="set-card">
            <button class="set-row" id="refreshRow">
              <span class="si"><svg class="ic"><use href="#i-refresh"/></svg></span>
              <span class="st"><b>Обновить расписание</b><small>С сайта факультета</small></span>
              <span class="sv">${updated}</span>
            </button>
            <a class="set-row" href="https://gtifem.ru/dekanat/raspisanie/" target="_blank" rel="noopener">
              <span class="si"><svg class="ic"><use href="#i-pin"/></svg></span>
              <span class="st"><b>Сайт расписания</b><small>gtifem.ru</small></span>
              <svg class="ic ic-chev"><use href="#i-chevron"/></svg>
            </a>
          </div>
        </div>

        <div class="set-group">
          <h4>О приложении</h4>
          <div class="set-card">
            <div class="set-row">
              <span class="si"><svg class="ic"><use href="#i-telegram"/></svg></span>
              <span class="st"><b>ФЭМ · Расписание</b><small>Неофициальное приложение · ${esc(CONFIG.version || '1.0')}</small></span>
            </div>
            <div class="set-row">
              <span class="st" style="font-size:12.5px;color:var(--muted-2);line-height:1.45">Сделано с любовью для студентов ФЭМ СПбГТИ(ТУ). Данные — с открытого сайта факультета, приложение их только красиво показывает.</span>
            </div>
          </div>
        </div>
      </div>`;

    $('#changeGroup')?.addEventListener('click', openPicker);
    $('#refreshRow')?.addEventListener('click', () => refresh(true));
    $('#notifyRow')?.addEventListener('click', notifyBot);
    $('#themeSeg')?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      applyTheme(b.dataset.theme);
      haptic('light');
      renderMore();
    }));
    $('#moreBody')?.querySelectorAll('.pal').forEach((b) => b.addEventListener('click', () => {
      applyPalette(b.dataset.pal);
      haptic('light');
      renderMore();
    }));
  }

  function fmtUpdated(isoStr) {
    try {
      const d = new Date(isoStr);
      return `${d.getDate()} ${MONTH_GEN[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) { return '—'; }
  }

  async function apiSubscribe(enable, quiet = false) {
    if (!state.groupId) {
      if (!quiet) { toast('Сначала выбери группу'); openPicker(); }
      return false;
    }
    const endpoint = enable ? '/api/subscribe' : '/api/unsubscribe';
    try {
      const res = await fetch((CONFIG.api || '') + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: tg?.initData || '', group: state.groupId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'fail');
      state.subscribed = !!data.subscribed;
      localStorage.setItem('fem:subscribed', state.subscribed ? '1' : '0');
      if (!quiet) {
        toast(state.subscribed ? 'Готово: сводка каждое утро в 8:00' : 'Напоминания выключены');
        haptic('medium');
        renderMore();
      }
      return true;
    } catch (err) {
      if (!quiet) toast('Не получилось — попробуй ещё раз');
      return false;
    }
  }

  function notifyBot() {
    // Внутри Telegram — тихо подписываемся по initData, без перехода в чат.
    if (tg?.initData) {
      apiSubscribe(!state.subscribed);
      return;
    }
    if (!CONFIG.bot) {
      toast('Бот пока не подключён');
      return;
    }
    // Telegram разрешает в start-параметре только [A-Za-z0-9_-], запятую заменяем на дефис.
    const start = state.groupId ? `?start=${encodeURIComponent(state.groupId.replace(/,/g, '-'))}` : '';
    const url = `https://t.me/${CONFIG.bot}${start}`;
    try {
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, '_blank');
    } catch (_) { window.open(url, '_blank'); }
  }


  /* ---------- картинка расписания ---------- */

  function rr(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    const t = String(text || '');
    if (ctx.measureText(t).width <= maxWidth) return t;
    let cut = t;
    while (cut.length > 2 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
    return cut.trimEnd() + '…';
  }

  function wrapText(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let cur = '';
    let i = 0;
    while (i < words.length && lines.length < maxLines) {
      const test = cur ? `${cur} ${words[i]}` : words[i];
      if (ctx.measureText(test).width <= maxWidth) {
        cur = test;
        i += 1;
      } else if (cur) {
        lines.push(cur);
        cur = '';
      } else {
        lines.push(fitText(ctx, words[i], maxWidth));
        i += 1;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (i < words.length && lines.length) {
      lines[lines.length - 1] = fitText(ctx, `${lines[lines.length - 1]} ${words.slice(i).join(' ')}`, maxWidth);
    }
    return lines;
  }

  function shareTarget(el) {
    if (el?.dataset?.day) return { kind: 'day', dateISO: el.dataset.day };
    if (el?.dataset?.share === 'week') return { kind: 'week' };
    if (state.tab === 'week') {
      return state.weekMode === 'week'
        ? { kind: 'week' }
        : { kind: 'day', dateISO: state.weekSelected || iso(mskNow()) };
    }
    if (state.tab === 'all') return { kind: 'day', dateISO: state.calSelected || iso(mskNow()) };
    return { kind: 'day', dateISO: iso(mskNow()) };
  }

  function shareCardData(target) {
    const group = groupInfo(state.groupId);
    if (!group || !state.schedule) return null;

    if (target.kind === 'week') {
      const monday = addDays(startOfWeek(mskNow()), state.weekOffset * 7);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = addDays(monday, i);
        return {
          date: iso(d),
          weekday: WD_SHORT[i],
          num: d.getDate(),
          day: dayOfSchedule(iso(d)),
        };
      });
      const sun = addDays(monday, 6);
      const range = monday.getMonth() === sun.getMonth()
        ? `${monday.getDate()}–${sun.getDate()} ${MONTH_GEN[sun.getMonth()]}`
        : `${monday.getDate()} ${MONTH_GEN[monday.getMonth()].slice(0, 3)} – ${sun.getDate()} ${MONTH_GEN[sun.getMonth()].slice(0, 3)}`;
      const count = days.reduce((n, d) => n + (d.day?.lessons?.length || 0), 0);
      return { kind: 'week', group, days, range, lessonsCount: count, monday };
    }

    let dateISO = target.dateISO || iso(mskNow());
    let day = dayOfSchedule(dateISO);
    if (!day || !day.lessons?.length) {
      const next = (state.schedule.days || []).find((d) => d.date > dateISO && d.lessons?.length);
      if (next) { dateISO = next.date; day = next; }
    }
    const date = parseISO(dateISO);
    return { kind: 'day', group, date, day, lessons: day?.lessons || [] };
  }

  function drawShareCard(data) {
    const pal = PALETTES.find((p) => p.id === state.paletteId) || PALETTES[0];
    const W = 1080;
    const H = data.kind === 'week' ? 1620 : 1350;
    const pad = 72;
    const F = (weight, size) => `${weight} ${size}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, pal.a);
    bg.addColorStop(1, pal.b);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    let glow = ctx.createRadialGradient(W * 0.82, H * 0.02, 10, W * 0.82, H * 0.02, W * 0.85);
    glow.addColorStop(0, 'rgba(150,190,255,.4)');
    glow.addColorStop(1, 'rgba(150,190,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    glow = ctx.createRadialGradient(W * 0.05, H * 0.95, 10, W * 0.05, H * 0.95, W * 0.6);
    glow.addColorStop(0, 'rgba(255,255,255,.14)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath(); ctx.arc(W * 0.94, H * 0.03, 300, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.04, H * 0.84, 220, 0, Math.PI * 2); ctx.fill();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.font = F(800, 27);
    ctx.fillText('ФЭМ', pad, 118);
    ctx.fillStyle = 'rgba(255,255,255,.26)';
    ctx.fillRect(pad + 88, 96, 2, 24);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = F(600, 18);
    ctx.fillText('СПбГТИ · РАСПИСАНИЕ', pad + 108, 116);

    const title = data.kind === 'week' ? 'Неделя' : cap(WD_FULL[(data.date.getDay() + 6) % 7]);
    const subtitle = data.kind === 'week'
      ? data.range
      : `${data.date.getDate()} ${MONTH_GEN[data.date.getMonth()]}`;

    ctx.fillStyle = '#FFFFFF';
    ctx.font = F(800, 82);
    ctx.fillText(fitText(ctx, title, W - pad * 2), pad, 286);
    ctx.fillStyle = 'rgba(255,255,255,.66)';
    ctx.font = F(500, 34);
    ctx.fillText(subtitle, pad, 344);

    const groupName = String(data.group.name);
    ctx.font = F(700, 24);
    const chipW = Math.min(ctx.measureText(groupName).width + 46, 420);
    const chipY = 384;
    rr(ctx, pad, chipY, chipW, 54, 15);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(groupName, pad + 23, chipY + 36);

    const count = data.kind === 'week' ? data.lessonsCount : data.lessons.length;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = F(500, 21);
    ctx.fillText(`${count} ${lessonsWord(count)}`, pad + chipW + 18, chipY + 36);

    ctx.textAlign = 'right';
    ctx.font = F(400, 18);
    ctx.fillStyle = 'rgba(255,255,255,.42)';
    ctx.fillText(fitText(ctx, `${data.group.speciality} · ${data.group.course} курс`, 330), W - pad, chipY + 36);
    ctx.textAlign = 'left';

    if (data.kind === 'week') {
      const top = 456;
      const rowH = 148;
      const gap = 8;
      data.days.forEach((d, i) => {
        const y = top + i * (rowH + gap);
        rr(ctx, pad, y, W - pad * 2, rowH, 22);
        ctx.fillStyle = 'rgba(255,255,255,.055)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.08)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = F(700, 19);
        ctx.fillText(String(d.weekday).toUpperCase(), pad + 26, y + 50);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = F(800, 40);
        ctx.fillText(String(d.num), pad + 26, y + 102);

        ctx.fillStyle = 'rgba(255,255,255,.1)';
        ctx.fillRect(pad + 96, y + 26, 2, 96);

        const lessons = d.day?.lessons || [];
        if (!lessons.length) {
          ctx.fillStyle = 'rgba(255,255,255,.32)';
          ctx.font = F(400, 22);
          ctx.fillText('свободно', pad + 122, y + 86);
        } else {
          const shown = lessons.slice(0, 3);
          shown.forEach((l, k) => {
            const ly = y + 48 + k * 34;
            ctx.fillStyle = '#FFFFFF';
            ctx.font = F(700, 21);
            ctx.fillText(l.start, pad + 122, ly);
            ctx.fillStyle = 'rgba(255,255,255,.78)';
            ctx.font = F(500, 21);
            ctx.fillText(fitText(ctx, l.subject, W - pad - (pad + 200) - 74), pad + 200, ly);
          });
          if (lessons.length > 3) {
            ctx.fillStyle = 'rgba(255,255,255,.4)';
            ctx.font = F(600, 18);
            ctx.textAlign = 'right';
            ctx.fillText(`+${lessons.length - 3}`, W - pad - 26, y + 48);
            ctx.textAlign = 'left';
          }
        }
      });
    } else {
      const lessons = data.lessons;
      if (!lessons.length) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = F(700, 46);
        ctx.fillText('Пар нет', pad, 500);
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = F(400, 26);
        ctx.fillText('Свободный день — можно выдохнуть.', pad, 548);
      } else {
        const n = Math.min(lessons.length, 6);
        const rowH = n <= 4 ? 144 : 124;
        const gap = n <= 4 ? 14 : 12;
        const blockH = n * rowH + (n - 1) * gap;
        const footerY = H - 110;
        const top = 470 + Math.max(0, Math.min(150, (footerY - 470 - blockH) / 2));

        lessons.slice(0, 6).forEach((l, i) => {
          const y = top + i * (rowH + gap);
          rr(ctx, pad, y, W - pad * 2, rowH, 24);
          ctx.fillStyle = 'rgba(255,255,255,.075)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.09)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = '#FFFFFF';
          ctx.font = F(700, 24);
          ctx.fillText(l.start, pad + 26, y + 50);
          ctx.fillStyle = 'rgba(255,255,255,.42)';
          ctx.font = F(400, 18);
          ctx.fillText(l.end, pad + 26, y + 80);

          ctx.fillStyle = pal.accent2;
          rr(ctx, pad + 104, y + 28, 4, 68, 2);
          ctx.fill();

          ctx.fillStyle = '#FFFFFF';
          ctx.font = F(600, 27);
          const lines = wrapText(ctx, l.subject, W - pad * 2 - 160 - 30, 2);
          lines.forEach((line, k) => ctx.fillText(line, pad + 132, y + 48 + k * 32));

          const meta = [l.room ? `ауд. ${l.room}` : '', l.teacher].filter(Boolean).join(' · ');
          if (meta) {
            ctx.fillStyle = 'rgba(255,255,255,.52)';
            ctx.font = F(400, 19);
            ctx.fillText(fitText(ctx, meta, W - pad * 2 - 170), pad + 132, y + (lines.length > 1 ? 108 : 84));
          }
        });

        if (lessons.length > 6) {
          ctx.fillStyle = 'rgba(255,255,255,.42)';
          ctx.font = F(500, 20);
          ctx.fillText(`и ещё ${lessons.length - 6} ${lessonsWord(lessons.length - 6)}`, pad + 6, top + blockH + 34);
        }
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.font = F(500, 18);
    ctx.fillText('ФЭМ · Расписание', pad, H - 46);
    ctx.textAlign = 'right';
    ctx.fillText('ttimm1.github.io/gtifem', W - pad, H - 46);
    ctx.textAlign = 'left';

    return canvas;
  }

  function sharePlainCaption(data) {
    return data.kind === 'week'
      ? `Расписание на неделю ${data.range} · группа ${data.group.name}`
      : `Расписание на ${data.date.getDate()} ${MONTH_GEN[data.date.getMonth()]} · группа ${data.group.name}`;
  }

  function shareHtmlCaption(data) {
    return data.kind === 'week'
      ? `Неделя <b>${esc(data.range)}</b> · группа <b>${esc(data.group.name)}</b>`
      : `Расписание на <b>${data.date.getDate()} ${esc(MONTH_GEN[data.date.getMonth()])}</b> · группа <b>${esc(data.group.name)}</b>`;
  }

  function closeShare() {
    $('#shareSheet').hidden = true;
    try { tg?.BackButton?.hide(); } catch (_) { /* noop */ }
  }

  function dataUrlToFile(dataUrl, name) {
    const parts = String(dataUrl).split(',');
    const mime = (/data:([^;]+)/.exec(parts[0]) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1] || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  function openShareSheet(url, name, data) {
    $('#shareImage').src = url;
    const dl = $('#shareDownload');
    dl.href = url;
    dl.setAttribute('download', name);
    $('#shareEyebrow').textContent = data.kind === 'week' ? 'Неделя' : 'Расписание на день';
    const send = $('#shareSend');
    send.hidden = !(tg?.initData);
    $('#shareSheet').hidden = false;
    $('#shareSheet').dataset.caption = shareHtmlCaption(data);
    try { tg?.BackButton?.show(); } catch (_) { /* noop */ }
  }

  async function sendShareToChat() {
    const btn = $('#shareSend');
    const caption = $('#shareSheet').dataset.caption || '';
    const image = $('#shareImage').src;
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.textContent = 'Отправляю…';
    try {
      const res = await fetch(`${CONFIG.api}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: tg?.initData || '', image, caption }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'fail');
      closeShare();
      toast('Отправил в чат — перешли картинку дальше');
    } catch (_) {
      toast('Не получилось отправить');
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  async function shareSchedule(el) {
    const data = shareCardData(shareTarget(el));
    if (!data) {
      toast('Сначала выбери группу');
      return;
    }
    haptic('light');

    // Всё, что можно, делаем синхронно: на iOS системный share-sheet
    // требует, чтобы navigator.share вызвали внутри жеста, без await.
    const canvas = drawShareCard(data);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const name = `fem-${String(data.group.id).replace(/,/g, '-')}-${data.kind}.jpg`;
    const file = dataUrlToFile(dataUrl, name);
    const plain = sharePlainCaption(data);

    if (navigator.share) {
      try {
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Расписание', text: plain });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    openShareSheet(dataUrl, name, data);
  }

  /* ---------- выбор группы ---------- */

  function openPicker() {
    state.query = '';
    $('#groupSearch').value = '';
    renderPicker();
    $('#picker').hidden = false;
    try { tg?.BackButton?.show(); } catch (_) { /* noop */ }
    setTimeout(() => $('#groupSearch').focus(), 120);
  }

  function closePicker() {
    $('#picker').hidden = true;
    try { tg?.BackButton?.hide(); } catch (_) { /* noop */ }
  }

  function renderPicker() {
    const tabs = $('#programTabs');
    tabs.innerHTML = PROGRAMS.map((p) => `<button data-p="${p}" class="${state.program === p ? 'on' : ''}">${p}</button>`).join('');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.program = b.dataset.p;
      renderPicker();
    }));

    const q = state.query.trim().toLowerCase();
    const groups = (state.catalog?.groups || []).filter((g) => {
      if (state.program !== 'Все' && g.program !== state.program) return false;
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        g.speciality.toLowerCase().includes(q) ||
        String(g.course).includes(q)
      );
    });

    const order = { 'Бакалавриат': 0, 'Магистратура': 1, 'СПО': 2 };
    groups.sort((a, b) => (order[a.program] - order[b.program]) || a.speciality.localeCompare(b.speciality, 'ru') || a.course - b.course || a.name.localeCompare(b.name));

    let html = '';
    let lastKey = '';
    for (const g of groups) {
      const key = `${g.program}|${g.speciality}|${g.course}`;
      if (key !== lastKey) {
        lastKey = key;
        html += `<div class="g-spec">${esc(g.speciality)} · ${g.course} курс</div>`;
      }
      const on = g.id === state.groupId;
      html += `<button class="g-row ${on ? 'on' : ''}" data-g="${esc(g.id)}">
        <span class="gn">${esc(g.name)}</span>
        <span class="gc">${esc(g.program === 'СПО' ? 'СПО' : g.program === 'Магистратура' ? 'маг.' : g.course + ' к.')}</span>
        ${on ? '<svg class="ic gs"><use href="#i-check"/></svg>' : ''}
      </button>`;
    }
    $('#groupList').innerHTML = html || `<div class="empty" style="margin-top:20px"><h3>Ничего не нашлось</h3><p>Попробуй другой номер или направление.</p></div>`;

    $('#groupList').querySelectorAll('.g-row').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.g;
      haptic('medium');
      setGroup(id);
      closePicker();
      await loadSchedule(id);
      renderAllScreens();
    }));
  }

  /* ---------- обновление ---------- */

  async function refresh(force = false) {
    const btn = $('#refreshBtn');
    btn.style.opacity = '.4';
    try {
      await loadCatalog(true);
      if (state.groupId) await loadSchedule(state.groupId, true);
      state.updated = state.catalog?.updated || state.updated;
      renderAllScreens();
      if (force) toast('Расписание обновлено');
    } catch (_) {
      if (force) toast('Не удалось обновить — нет сети');
    } finally {
      btn.style.opacity = '';
    }
  }

  /* ---------- роутинг ---------- */

  function renderAllScreens() {
    renderToday();
    renderWeek();
    renderAll();
    renderMore();
    $('#groupChipText').textContent = state.groupId ? (groupInfo(state.groupId)?.name || state.groupId) : 'Группа';
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.screen !== tab; });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    const titles = { today: 'Сегодня', week: 'Неделя', all: 'Всё расписание', more: 'Ещё' };
    $('#screenTitle').textContent = titles[tab];
    if (tab === 'week') renderWeek();
    if (tab === 'all') renderAll();
    if (tab === 'more') renderMore();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    haptic('light');
  }

  /* ---------- старт ---------- */

  async function init(force = false) {
    state.loading = true;
    renderToday();

    applyTheme(localStorage.getItem(LS.theme) || 'light', false);
    applyPalette(localStorage.getItem(LS.palette) || 'ocean', false);

    if (tg) {
      try {
        tg.ready();
        tg.expand();
        tg.setHeaderColor('#F4F1EE');
        tg.onEvent?.('themeChanged', syncTelegramChrome);
      } catch (_) { /* noop */ }
      matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        syncAccent();
        syncTelegramChrome();
      });
    }

    const params = new URLSearchParams(location.search);
    if (params.get('theme')) applyTheme(params.get('theme'), false);
    if (params.get('now')) {
      const d = new Date(params.get('now'));
      if (!isNaN(d)) DEBUG_NOW = d;
    }

    let gid = localStorage.getItem(LS.group) || null;
    const startParam = tg?.initDataUnsafe?.start_param || '';
    const deepGroup = startParam && /^[0-9]+(-[0-9]+)*$/.test(startParam) ? startParam.replace(/-/g, ',') : '';
    if (params.get('group')) gid = params.get('group');
    else if (deepGroup) gid = deepGroup;
    try {
      const cloud = await new Promise((resolve) => {
        if (!tg?.CloudStorage?.getItem) return resolve(null);
        tg.CloudStorage.getItem('group', (err, val) => resolve(err ? null : val));
      });
      if (cloud && !gid) gid = cloud;
      if (gid) localStorage.setItem(LS.group, gid);
    } catch (_) { /* noop */ }

    state.groupId = gid;

    try {
      await loadCatalog(force);
      if (gid) await loadSchedule(gid, force);
      state.error = null;
    } catch (err) {
      state.error = 'Проверь интернет и попробуй ещё раз.';
    }

    if (params.get('card')) {
      const target = params.get('card') === 'week'
        ? { kind: 'week' }
        : { kind: 'day', dateISO: params.get('date') || iso(mskNow()) };
      const cardData = shareCardData(target);
      if (cardData) {
        const canvas = drawShareCard(cardData);
        hideSplash(0);
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;background:#000';
        const img = new Image();
        img.src = canvas.toDataURL('image/png');
        img.style.cssText = 'width:100%;display:block';
        document.body.appendChild(img);
        return;
      }
    }

    if (params.get('sheet')) {
      const target = params.get('sheet') === 'week' ? { kind: 'week' } : { kind: 'day', dateISO: params.get('date') || iso(mskNow()) };
      const cardData = shareCardData(target);
      if (cardData) openShareSheet(drawShareCard(cardData).toDataURL('image/jpeg', 0.92), 'preview.jpg', cardData);
    }

    state.loading = false;
    renderAllScreens();
    if (params.get('screen')) setTab(params.get('screen'));
    if (params.get('picker')) setTimeout(openPicker, 200);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    $('#groupChip').addEventListener('click', openPicker);
    $('#pickerClose').addEventListener('click', closePicker);
    $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
    $('#refreshBtn').addEventListener('click', () => refresh(true));
    $('#groupSearch').addEventListener('input', (e) => { state.query = e.target.value; renderPicker(); });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-share]');
      if (btn) {
        e.preventDefault();
        shareSchedule(btn);
      }
    });

    $('#shareClose').addEventListener('click', closeShare);
    $('#shareSheet').addEventListener('click', (e) => { if (e.target.id === 'shareSheet') closeShare(); });
    $('#shareSend').addEventListener('click', sendShareToChat);

    $('#weekPrev').addEventListener('click', () => { state.weekOffset -= 1; state.weekSelected = null; renderWeek(); haptic('light'); });
    $('#weekNext').addEventListener('click', () => { state.weekOffset += 1; state.weekSelected = null; renderWeek(); haptic('light'); });
    $('#dayStrip').addEventListener('click', (e) => {
      const b = e.target.closest('[data-day]');
      if (!b) return;
      state.weekSelected = b.dataset.day;
      renderWeek();
      if (state.weekMode === 'week') {
        document.getElementById('wd-' + b.dataset.day)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      haptic('light');
    });

    $('#weekBody').addEventListener('click', (e) => {
      const head = e.target.closest('[data-goday]');
      if (!head) return;
      state.weekSelected = head.dataset.goday;
      state.weekMode = 'day';
      renderWeek();
      haptic('light');
    });

    $('#calPrev').addEventListener('click', () => {
      state.cal.m -= 1;
      if (state.cal.m < 0) { state.cal.m = 11; state.cal.y -= 1; }
      state.calSelected = null;
      renderAll();
      haptic('light');
    });
    $('#calNext').addEventListener('click', () => {
      state.cal.m += 1;
      if (state.cal.m > 11) { state.cal.m = 0; state.cal.y += 1; }
      state.calSelected = null;
      renderAll();
      haptic('light');
    });
    $('#calendar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (!b) return;
      state.calSelected = b.dataset.date;
      renderAll();
      haptic('light');
    });

    try {
      tg?.BackButton?.onClick(() => {
        if (!$('#shareSheet').hidden) closeShare();
        else closePicker();
      });
    } catch (_) { /* noop */ }

    setTab('today');
    setTimeout(() => hideSplash(0), 2600);
    init()
      .catch(() => {
        state.loading = false;
        state.error = 'Не удалось загрузить расписание.';
        renderAllScreens();
      })
      .finally(() => hideSplash(1050));
  });
})();
