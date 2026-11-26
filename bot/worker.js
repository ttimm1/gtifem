/**
 * ФЭМ · Расписание — Telegram-бот (Cloudflare Worker).
 *
 * Возможности:
 *   /start [группа]  — приветствие + кнопка Mini App, подписка на утреннюю сводку
 *   /today           — пары на сегодня текстом
 *   /week            — пары на неделю текстом
 *   /stop            — отключить сводку
 *   /help
 *   cron 2 раза в день — утренняя сводка (08:00 МСК) и вечерняя (20:00 МСК)
 *
 * Переменные окружения (wrangler secret / vars):
 *   BOT_TOKEN       — токен от @BotFather
 *   WEBHOOK_SECRET  — произвольная строка, проверяется в заголовке Telegram
 *   WEBAPP_URL      — https://ttimm1.github.io/gtifem/
 *   DATA_URL        — https://ttimm1.github.io/gtifem/data
 *   USERS           — KV namespace
 */

const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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

/** Текущее время в Москве, но в UTC-полях (чтобы сравнивать с датами из JSON). */
function mskNow() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return d;
}

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

async function groupName(env, id) {
  try {
    const cat = await fetchData(env, 'catalog.json');
    const g = (cat.groups || []).find((x) => x.id === id);
    return g ? g.name : id;
  } catch (_) {
    return id;
  }
}

function dayText(day, date, opts = {}) {
  if (!day || !day.lessons?.length) return '';
  const list = day.lessons
    .map((l) => {
      const meta = [l.room ? `ауд. ${l.room}` : '', l.teacher].filter(Boolean).map(escapeHtml).join(' · ');
      return `<b>${escapeHtml(l.start)}</b>–${escapeHtml(l.end)}  ${escapeHtml(l.subject)}` + (meta ? `\n     <i>${meta}</i>` : '');
    })
    .join('\n');
  return list;
}

function buildToday(schedule, now) {
  const key = iso(now);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let day = (schedule.days || []).find((d) => d.date === key);
  let headerLabel = `${WD_FULL[new Date(key + 'T00:00:00Z').getUTCDay()]}, ${now.getUTCDate()} ${MONTH_GEN[now.getUTCMonth()]}`;

  if (!day) {
    const next = (schedule.days || []).find((d) => d.date > key);
    if (!next) return `🗓 <b>Сегодня пар нет</b>\n${escapeHtml(headerLabel)}\n\nРасписание на этот день не опубликовано.`;
    day = next;
    const d = new Date(next.date + 'T00:00:00Z');
    headerLabel = `${WD_FULL[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH_GEN[d.getUTCMonth()]}`;
    return `☕️ <b>Сегодня пар нет</b>\n\nБлижайшие занятия — <b>${escapeHtml(headerLabel)}</b>:\n\n${dayText(day)}`;
  }

  const first = day.lessons[0];
  const last = day.lessons[day.lessons.length - 1];
  let prefix = '';
  if (nowMin < minOf(first.start)) prefix = `До первой пары ${minOf(first.start) - nowMin} мин.\n\n`;
  else if (nowMin > minOf(last.end)) prefix = 'Занятия закончились. Хорошего вечера!\n\n';

  return `🗓 <b>${escapeHtml(headerLabel)}</b>\nГруппа <b>${escapeHtml(schedule.name || schedule.group)}</b> · ${day.lessons.length} ${lessonsWord(day.lessons.length)}\n\n${prefix}${dayText(day)}`;
}

function buildWeek(schedule, now) {
  const key = iso(now);
  const base = new Date(key + 'T00:00:00Z');
  const monday = new Date(base);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

  const parts = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    const dk = iso(d);
    const day = (schedule.days || []).find((x) => x.date === dk);
    const label = `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_GEN[d.getUTCMonth()]}`;
    if (!day || !day.lessons.length) {
      parts.push(`<b>${escapeHtml(label)}</b> — свободно`);
    } else {
      const lines = day.lessons.map((l) => `${escapeHtml(l.start)} ${escapeHtml(l.subject)}${l.room ? ` · ауд. ${escapeHtml(l.room)}` : ''}`);
      parts.push(`<b>${escapeHtml(label)}</b>\n${lines.join('\n')}`);
    }
  }
  const sun = new Date(monday);
  sun.setUTCDate(sun.getUTCDate() + 6);
  const title = `${monday.getUTCDate()}–${sun.getUTCDate()} ${MONTH_GEN[sun.getUTCMonth()]}`;
  return `📅 <b>Неделя ${escapeHtml(title)}</b>\nГруппа <b>${escapeHtml(schedule.name || schedule.group)}</b>\n\n${parts.join('\n\n')}`;
}

function keyboard(env, extra = []) {
  return {
    inline_keyboard: [
      ...extra,
      [{ text: '📱 Открыть расписание', web_app: { url: env.WEBAPP_URL } }],
    ],
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
      } catch (_) { /* offline — поверим пользователю */ }
      if (!name) {
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: 'Не нашёл такую группу. Открой приложение и выбери её в списке — тогда я всё запомню.',
          reply_markup: keyboard(env),
        });
        return;
      }
      await saveUser(env, chatId, arg, true);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text:
          `Готово! Группа <b>${escapeHtml(name)}</b> сохранена.\n\n` +
          `Каждое утро в 8:00 буду присылать расписание на день. ` +
          `Отключить — /stop.\n\n` +
          `А красивое расписание с календарём — по кнопке ниже.`,
        parse_mode: 'HTML',
        reply_markup: keyboard(env),
      });
      return;
    }

    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text:
        `<b>ФЭМ · Расписание</b>\n\n` +
        `Пары на сегодня, неделя и весь семестр — в одном приложении.\n\n` +
        `Открой его кнопкой ниже и один раз выбери группу. ` +
        `Хочешь получать расписание в 8:00 — нажми «Напоминания» в настройках приложения.`,
      parse_mode: 'HTML',
      reply_markup: keyboard(env),
    });
    return;
  }

  if (cmd === '/stop') {
    if (env.USERS) await env.USERS.delete(`u:${chatId}`);
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Ок, сводку больше не присылаю. Вернуть — /start.' });
    return;
  }

  if (cmd === '/help') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text:
        `<b>Команды</b>\n` +
        `/today — пары на сегодня\n` +
        `/week — пары на неделю\n` +
        `/stop — отключить утреннюю сводку\n` +
        `/start — открыть приложение`,
      parse_mode: 'HTML',
      reply_markup: keyboard(env),
    });
    return;
  }

  if (cmd === '/today' || cmd === '/week') {
    if (!groupId) {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Сначала выбери группу в приложении — и нажми «Напоминания», чтобы я её запомнил.',
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
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Не получилось загрузить расписание, попробуй позже.' });
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
        const key2 = iso(tomorrow);
        const day = (sched.days || []).find((d) => d.date === key2);
        body = day
          ? `🌙 <b>Завтра</b>, ${WD_FULL[tomorrow.getUTCDay()]}, ${tomorrow.getUTCDate()} ${MONTH_GEN[tomorrow.getUTCMonth()]}\n\n${dayText(day)}`
          : `🌙 Завтра пар нет — можно выспаться.`;
      } else {
        body = buildToday(sched, now);
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
