/**
 * ФЭМ · Расписание — Telegram-бот (Cloudflare Worker).
 *
 *   /start [группа]  — приветствие, кнопка Mini App, подписка на утреннюю сводку
 *   /today           — пары на сегодня
 *   /week            — пары на неделю
 *   /stop            — выключить сводку
 *   /help
 *   POST /api/subscribe   — подписка из приложения (initData)
 *   POST /api/unsubscribe — отписка
 *   POST /api/share       — прислать картинку расписания в чат
 *   cron 2 раза в день    — утренняя сводка (08:00 МСК) и вечерняя (20:00 МСК)
 *
 * Переменные окружения:
 *   BOT_TOKEN, WEBHOOK_SECRET, WEBAPP_URL, DATA_URL, USERS (KV)
 */

const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const minOf = (t) => {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return h * 60 + m;
};
const plural = (n, f) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b === 1) return f[0];
  if (b >= 2 && b <= 4) return f[1];
  return f[2];
};
const lessonsWord = (n) => plural(n, ['пара', 'пары', 'пар']);

function countdown(mins) {
  if (mins < 1) return 'меньше минуты';
  if (mins < 60) return `${mins} ${plural(mins, ['минута', 'минуты', 'минут'])}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

const CORS_ORIGIN = 'https://ttimm1.github.io';

/** Текущее время в Москве, но в UTC-полях (чтобы сравнивать с датами из JSON). */
function mskNow() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

function dayHeadline(d) {
  return `${WD_FULL[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_GEN[d.getUTCMonth()]}`;
}

/* ---------- Telegram / данные ---------- */

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function fetchData(env, path) {
  const url = `${env.DATA_URL.replace(/\/$/, '')}/${path}`;
  const res = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!res.ok) throw new Error(`data ${res.status}`);
  return res.json();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
  };
}

function jsonOut(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

const enc = new TextEncoder();

async function hmacSha256(key, data) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

const toHex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Проверка Telegram WebApp initData (подпись и свежесть). */
async function checkInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  if (!hash) return null;
  params.delete('hash');

  const pairs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  // secret_key = HMAC_SHA256(bot_token, "WebAppData"): ключ — "WebAppData", данные — токен.
  const secret = await hmacSha256('WebAppData', botToken);
  const expected = toHex(await hmacSha256(secret, dataCheckString));
  if (expected !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

/* ---------- API приложения ---------- */

async function handleApi(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonOut({ ok: false, error: 'bad_json' }, 400);
  }
  const user = await checkInitData(body.initData, env.BOT_TOKEN);
  if (!user) return jsonOut({ ok: false, error: 'bad_init' }, 401);

  const group = String(body.group || '').trim();
  const action = new URL(request.url).pathname;

  if (action.endsWith('/unsubscribe')) {
    if (env.USERS) await env.USERS.delete(`u:${user.id}`);
    return jsonOut({ ok: true, subscribed: false });
  }

  if (!group) return jsonOut({ ok: false, error: 'no_group' }, 400);

  let name = '';
  try {
    const cat = await fetchData(env, 'catalog.json');
    const g = (cat.groups || []).find((x) => x.id === group || x.name === group);
    if (g) name = g.name;
  } catch (_) { /* offline — поверим на слово */ }
  if (!name) return jsonOut({ ok: false, error: 'unknown_group' }, 404);

  const prev = env.USERS ? await env.USERS.get(`u:${user.id}`, 'json') : null;
  if (env.USERS) {
    await env.USERS.put(`u:${user.id}`, JSON.stringify({
      group, enabled: true, added: prev?.added || Date.now(),
      name: user.username || user.first_name || '',
    }));
  }
  return jsonOut({ ok: true, subscribed: true, group, name });
}

async function handleShare(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonOut({ ok: false, error: 'bad_json' }, 400);
  }
  const user = await checkInitData(body.initData, env.BOT_TOKEN);
  if (!user) return jsonOut({ ok: false, error: 'bad_init' }, 401);

  const b64 = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) return jsonOut({ ok: false, error: 'no_image' }, 400);
  if (b64.length > 9_000_000) return jsonOut({ ok: false, error: 'too_big' }, 413);

  let bytes;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch (_) {
    return jsonOut({ ok: false, error: 'bad_image' }, 400);
  }

  const mime = (/^data:(image\/[a-z+]+);base64/i.exec(String(body.image || '')) || [])[1] || 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : 'jpg';

  // Фото уходит без подписи — человек пересылает его как обычную картинку.
  const form = new FormData();
  form.append('chat_id', String(user.id));
  form.append('photo', new Blob([bytes], { type: mime }), `schedule.${ext}`);

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({ ok: false }));
  return jsonOut({ ok: !!data.ok, error: data.ok ? undefined : (data.description || 'send_failed') });
}

/* ---------- тексты расписания ---------- */

function dayText(day) {
  if (!day || !day.lessons?.length) return '';
  return day.lessons
    .map((l) => {
      const meta = [l.room ? `ауд. ${l.room}` : '', l.teacher].filter(Boolean).map(escapeHtml).join(' · ');
      return `<b>${escapeHtml(l.start)}</b>–${escapeHtml(l.end)}  ${escapeHtml(l.subject)}` +
        (meta ? `\n     <i>${meta}</i>` : '');
    })
    .join('\n');
}

function buildToday(schedule, now) {
  const key = iso(now);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const name = schedule.name || schedule.group;
  const all = schedule.days || [];
  const day = all.find((d) => d.date === key);

  if (!day) {
    const next = all.find((d) => d.date > key);
    if (!next) return '🗓 <b>Сегодня пар нет</b>\n\nНа этот день расписание ещё не выложили.';
    const nd = new Date(next.date + 'T00:00:00Z');
    return `🌿 <b>Сегодня пар нет</b>\n\nБлижайшие занятия — ${escapeHtml(cap(dayHeadline(nd)))}:\n\n${dayText(next)}`;
  }

  const lessons = day.lessons;
  const first = lessons[0];
  const last = lessons[lessons.length - 1];
  const current = lessons.find((l) => nowMin >= minOf(l.start) && nowMin < minOf(l.end));

  let note = '';
  if (current) note = `Сейчас идёт «${escapeHtml(current.subject)}» до ${escapeHtml(current.end)}.\n\n`;
  else if (nowMin < minOf(first.start)) note = `До первой пары ${countdown(minOf(first.start) - nowMin)}.\n\n`;
  else if (nowMin >= minOf(last.end)) note = 'На сегодня всё. Хорошего вечера.\n\n';

  return `🗓 <b>${escapeHtml(cap(dayHeadline(new Date(key + 'T00:00:00Z'))))}</b>\n` +
    `Группа <b>${escapeHtml(name)}</b> · ${lessons.length} ${lessonsWord(lessons.length)}\n\n` +
    note + dayText(day);
}

function buildWeek(schedule, now) {
  const key = iso(now);
  const base = new Date(key + 'T00:00:00Z');
  const monday = new Date(base);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const name = schedule.name || schedule.group;

  const parts = [];
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    const day = (schedule.days || []).find((x) => x.date === iso(d));
    const label = `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()}`;
    if (!day || !day.lessons.length) {
      parts.push(`<b>${escapeHtml(label)}</b> — свободно`);
      continue;
    }
    total += day.lessons.length;
    const lines = day.lessons.map((l) =>
      `${escapeHtml(l.start)} ${escapeHtml(l.subject)}${l.room ? ` · ${escapeHtml(l.room)}` : ''}`
    );
    parts.push(`<b>${escapeHtml(label)}</b>\n${lines.join('\n')}`);
  }

  const sun = new Date(monday);
  sun.setUTCDate(sun.getUTCDate() + 6);
  const title = monday.getUTCMonth() === sun.getUTCMonth()
    ? `${monday.getUTCDate()}–${sun.getUTCDate()} ${MONTH_GEN[sun.getUTCMonth()]}`
    : `${monday.getUTCDate()} ${MONTH_GEN[monday.getUTCMonth()].slice(0, 3)} – ${sun.getUTCDate()} ${MONTH_GEN[sun.getUTCMonth()].slice(0, 3)}`;

  return `📅 <b>Неделя ${escapeHtml(title)}</b>\n` +
    `Группа <b>${escapeHtml(name)}</b> · ${total} ${lessonsWord(total)}\n\n` +
    parts.join('\n\n');
}

function keyboard(env) {
  return {
    inline_keyboard: [[{ text: 'Открыть расписание', web_app: { url: env.WEBAPP_URL } }]],
  };
}

async function saveUser(env, chatId, groupId, enabled = true) {
  if (!env.USERS) return;
  const key = `u:${chatId}`;
  const prev = await env.USERS.get(key, 'json');
  await env.USERS.put(
    key,
    JSON.stringify({ group: groupId || prev?.group || '', enabled, added: prev?.added || Date.now() })
  );
}

/* ---------- апдейты ---------- */

async function handleUpdate(env, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const rawArg = rest.join(' ').trim();
  // В start-параметре Telegram запятая запрещена — приложение шлёт дефис.
  const arg = rawArg.replace(/-/g, ',');

  const user = env.USERS ? await env.USERS.get(`u:${chatId}`, 'json') : null;
  const groupId = arg || user?.group || '';

  if (cmd === '/start') {
    if (arg) {
      let name = '';
      try {
        const cat = await fetchData(env, 'catalog.json');
        const g = (cat.groups || []).find((x) => x.id === arg || x.name === arg);
        if (g) name = g.name;
      } catch (_) { /* offline — поверим на слово */ }

      if (!name) {
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: 'Такой группы нет в списке. Открой приложение и выбери свою — тогда запомню.',
          reply_markup: keyboard(env),
        });
        return;
      }

      await saveUser(env, chatId, arg, true);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text:
          `Запомнил: группа <b>${escapeHtml(name)}</b>.\n\n` +
          'Каждое утро в 8:00 пришлю пары на день. Не нужно — /stop.',
        parse_mode: 'HTML',
        reply_markup: keyboard(env),
      });
      return;
    }

    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text:
        '<b>ФЭМ · Расписание</b>\n\n' +
        'Пары на сегодня и на неделю, календарь на семестр и красивая картинка, которой можно поделиться.\n\n' +
        'Открой приложение и выбери группу — дальше всё запомнится.',
      parse_mode: 'HTML',
      reply_markup: keyboard(env),
    });
    return;
  }

  if (cmd === '/stop') {
    if (env.USERS) await env.USERS.delete(`u:${chatId}`);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Хорошо, утреннюю сводку выключил. Вернуть — /start.',
    });
    return;
  }

  if (cmd === '/help') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text:
        '<b>Что умеет бот</b>\n\n' +
        '/today — пары на сегодня\n' +
        '/week — пары на неделю\n' +
        '/stop — выключить утреннюю сводку\n' +
        '/start — открыть приложение\n\n' +
        'В приложении: календарь на семестр, тёмная тема и картинка расписания для друзей.',
      parse_mode: 'HTML',
      reply_markup: keyboard(env),
    });
    return;
  }

  if (cmd === '/today' || cmd === '/week') {
    if (!groupId) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Сначала выбери группу в приложении — там же включаются напоминания.',
        reply_markup: keyboard(env),
      });
      return;
    }
    try {
      const sched = await fetchData(env, `schedule/${groupId.replace(/,/g, '-')}.json`);
      const body = cmd === '/today' ? buildToday(sched, mskNow()) : buildWeek(sched, mskNow());
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: body.slice(0, 3900),
        parse_mode: 'HTML',
        reply_markup: keyboard(env),
      });
    } catch (err) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Сайт с расписанием не отвечает. Попробуй через пару минут.',
      });
    }
    return;
  }
}

async function digest(env, evening) {
  if (!env.USERS) return;
  const now = mskNow();
  const list = await env.USERS.list({ prefix: 'u:', limit: 1000 });
  const cache = new Map();

  for (const key of list.keys) {
    const user = await env.USERS.get(key.name, 'json');
    if (!user?.enabled || !user.group) continue;
    const chatId = key.name.slice(2);
    try {
      let sched = cache.get(user.group);
      if (!sched) {
        sched = await fetchData(env, `schedule/${user.group.replace(/,/g, '-')}.json`);
        cache.set(user.group, sched);
      }

      let body;
      if (evening) {
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const day = (sched.days || []).find((d) => d.date === iso(tomorrow));
        body = day
          ? `🌙 <b>Завтра, ${escapeHtml(dayHeadline(tomorrow))}</b>\n` +
            `Группа <b>${escapeHtml(sched.name || sched.group)}</b> · ${day.lessons.length} ${lessonsWord(day.lessons.length)}\n\n` +
            dayText(day)
          : '🌙 Завтра пар нет — выспись как следует.';
      } else {
        body = `☀️ <b>Доброе утро</b>\n\n${buildToday(sched, now)}`;
      }

      await tg(env, 'sendMessage', {
        chat_id: Number(chatId),
        text: body.slice(0, 3900),
        parse_mode: 'HTML',
        reply_markup: keyboard(env),
      });
    } catch (_) {
      // не роняем рассылку из-за одного пользователя
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'fem-schedule-bot' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/subscribe' || url.pathname === '/api/unsubscribe') {
      if (request.method !== 'POST') return jsonOut({ ok: false }, 405);
      return handleApi(request, env);
    }

    if (url.pathname === '/api/share') {
      if (request.method !== 'POST') return jsonOut({ ok: false }, 405);
      return handleShare(request, env);
    }

    if (url.pathname === '/telegram' && request.method === 'POST') {
      const secret = request.headers.get('x-telegram-bot-api-secret-token');
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch (_) {
        return new Response('bad request', { status: 400 });
      }
      try {
        await handleUpdate(env, update);
      } catch (err) {
        console.error('update failed', err);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env) {
    const hourUtc = new Date(event.scheduledTime).getUTCHours();
    await digest(env, hourUtc >= 12);
  },
};
