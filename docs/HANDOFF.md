# HANDOFF — ФЭМ · Расписание (Telegram Mini App)

Состояние проекта на 26 ноября 2026. Коротко: приложение готово и живёт на
GitHub Pages, данные обновляются само через GitHub Actions, бот живёт на
Cloudflare Workers.

## Что это

Telegram Mini App с расписанием занятий факультета экономики и менеджмента
СПбГТИ(ТУ) (ФЭМ). Сделано по мотивам нативного iOS-приложения
`~/Desktop/Приложение/RANEPA Schedule 2` — та же визуальная система (бордовый
градиент, скруглённые карточки, тёмная тема, палитры), но в вебе и без App Store.

- Приложение: <https://ttimm1.github.io/gtifem/>
- Репозиторий: <https://github.com/ttimm1/gtifem>
- Бот: <https://t.me/spbgti_raspisanie_bot>
- Источник данных: <https://gtifem.ru/dekanat/raspisanie/>

## Структура

```
gtifem/
  docs/                 ← это и есть сайт (GitHub Pages: main /docs)
    index.html
    assets/app.js       вся логика Mini App, без сборки
    assets/styles.css   дизайн-система
    assets/config.js    username бота, версия
    assets/icon-*.png   иконки (генерируются tools/make_icon.py)
    data/catalog.json   43 группы + статистика
    data/schedule/*.json расписание по группам (сентябрь–декабрь 2026)
  tools/
    scrape.py           скрапер сайта gtifem.ru
    make_icon.py        иконка/аватар бота
    preview/render.swift рендер страницы в PNG + выполнение JS (проверка вёрстки)
    preview/ocr.swift   OCR скриншотов (Vision)
  bot/
    worker.js           Telegram-бот (Cloudflare Worker)
    deploy.py           деплой воркера + настройка бота в Telegram
    .webhook_secret     сгенерированный секрет вебхука (в git не попадает)
  .github/workflows/refresh.yml   ежедневное обновление расписания
```

## Как устроен источник данных

Сайт — Bitrix. Страница расписания пустая, всё грузится AJAX-ом **POST на ту же
страницу** `/dekanat/raspisanie/`:

| Поля                         | Ответ                                    |
| ---------------------------- | ---------------------------------------- |
| `special`, `course`          | JSON `[["6611","6611"], …]` — группы     |
| `special`, `course`, `group` | JSON `["сентябрь","октябрь", …]` — месяцы |
| + `month`                    | HTML с таблицами занятий                 |

Особенности, на которые уже наступили и которые учтены в `tools/scrape.py`:

- в одной `<table>` несколько «шапок» по неделям (`<tr class="lesson-line">` с
  датами) — нельзя брать только `rows[0]`;
- месяцы приходят в нижнем регистре (`ноябрь`), а в шапке — `2 Ноября`;
- группа может быть слитой: `"6511,6512"` — и в имени файла запятая заменена на
  дефис;
- преподаватель — это `tail` после `div.aud`, а не текст ячейки;
- пустые ячейки — это `<div class="subject"></div>`, их надо пропускать;
- в ответе бывает `null` или HTML-ошибка Bitrix вместо JSON — обрабатывается;
- сайт периодически отдаёт пустую таблицу: скрапер не затирает прежние данные,
  если новых дней меньше 40 % от старых.

Даты восстанавливаются по номеру дня и месяцу, год подбирается так, чтобы дата
была рядом с сегодняшней (переход через Новый год работает).

## Автообновление

`.github/workflows/refresh.yml` каждый день в 06:30 МСК:

1. `python tools/scrape.py --no-cache` — заново собирает каталог и расписание;
2. проверяет, что групп > 20 и пар > 2000 (защита от «сайт лёг»);
3. коммитит `docs/data` — GitHub Pages пересобирается сам.

С GitHub Actions сайт доступен напрямую (проверено: GET 200, POST 200 с
раннера в Azure westus3). VPN на Mac ломал TLS именно к этому хосту — лечится
`--interface en0` у curl (в скрапере — `GTIFEM_IFACE=en0`).

## Бот

`bot/worker.js` — Cloudflare Worker:

- `POST /telegram` — вебхук, проверяет `X-Telegram-Bot-Api-Secret-Token`;
- `/start` — приветствие + кнопка Mini App (`web_app`);
- `/start 6611` — deep link из приложения «Напоминания»: сохраняет группу в KV;
- `/today`, `/week` — расписание текстом;
- `/stop` — отписаться от сводки;
- cron `0 5 * * *` — утренняя сводка в 08:00 МСК, `0 17 * * *` — вечерняя
  (завтра) в 20:00 МСК;
- `setChatMenuButton` — кнопка «Расписание» в чате, открывает приложение
  мгновенно, без участия бота.

Подписчики лежат в KV (`USERS`, ключи `u:<chat_id>`).

**Напоминания включаются прямо в приложении.** Кнопка «Напоминания в боте» в
разделе «Ещё» шлёт `POST /api/subscribe` с `initData` из Telegram. Воркер
проверяет подпись по алгоритму WebApp:

```
secret_key = HMAC_SHA256(bot_token, ключ "WebAppData")
hash       = hex(HMAC_SHA256(data_check_string, secret_key))
```

`data_check_string` — все поля initData, кроме `hash`, отсортированные по имени
и склеенные через `\n`. Плюс проверка `auth_date` (не старше суток) и что
группа есть в каталоге. Ответ `{ ok: true, subscribed: true }`.

CORS открыт только для `https://ttimm1.github.io`. Вне Telegram кнопка
открывает `t.me/<bot>?start=<группа>` (fallback).

## Деплой бота

```bash
CLOUDFLARE_API_TOKEN=... BOT_TOKEN=... python3 bot/deploy.py
```

Скрипт идемпотентный: создаёт KV, заливает воркер, ставит секреты, cron,
вебхук, команды, кнопку меню и описания. Для повторного запуска достаточно
тех же двух переменных.

## Локальная разработка

```bash
# сайт
python3 -m http.server 8899
open http://127.0.0.1:8899/docs/?group=6611

# скрапер (macOS с VPN)
python3 tools/scrape.py --iface en0

# проверка вёрстки без браузера
swiftc -O tools/preview/render.swift -o /tmp/render
/tmp/render "http://127.0.0.1:8899/docs/?group=6611" /tmp/shot.png 390 844 2000
```

Отладочные параметры URL (работают и в проде, безвредны):

- `?group=6611` — выбрать группу;
- `?theme=dark|light|auto`;
- `?screen=today|week|all|more`;
- `?now=2026-11-26T10:05` — заморозить время (для проверки «сейчас идёт»);
- `?picker=1` — сразу открыть выбор группы.

## Что можно улучшить дальше

- уведомление за 15 минут до пары (сейчас только утренняя/вечерняя сводка);
- поиск преподавателя и расписание преподавателей (`raspisanie-prepodavateley`);
- следующий семестр (январь) появится на сайте сам — приложение подхватит;
- аватар бота ставится только через @BotFather (файл `docs/assets/bot-avatar.png`).
