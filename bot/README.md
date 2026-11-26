# Бот

Telegram-бот `@spbgti_raspisanie_bot` на Cloudflare Workers.

- Worker: `worker.js`
- Деплой и настройка Telegram: `deploy.py`
- Конфиг для wrangler: `wrangler.toml`

## Что уже сделано

- KV-хранилище `FEM_USERS` создано;
- воркер задеплоен: <https://fem-schedule-bot.timur-fem.workers.dev>;
- секреты `BOT_TOKEN` и `WEBHOOK_SECRET` установлены;
- cron: `* * * * *` — сводка идёт по минутам с 07:00 до 08:00 и с 20:00 до
  21:00 МСК; каждая минута обслуживает свою пачку подписчиков;
- вебхук, команды, кнопка меню «Расписание», описания — настроены.

## Передеплой после правок

```bash
cd bot
PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH" \
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" dlx wrangler@latest deploy
```

или полностью (воркер + Telegram):

```bash
CLOUDFLARE_API_TOKEN=... BOT_TOKEN=... python3 bot/deploy.py
```

Cron через API Cloudflare иногда отвечает `Could not parse request body` —
это нормально, расписание уже стоит через wrangler. Проверить:

```bash
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/fem-schedule-bot/schedules"
```

## Что осталось руками (1 минута)

Аватар бота ставится только через @BotFather:

1. Открой @BotFather → `/setuserpic` → выбери `@spbgti_raspisanie_bot`.
2. Отправь файл `docs/assets/bot-avatar.png`.

## Безопасность

Токены (GitHub PAT и Cloudflare API) нужны были только для первичной
настройки. В репозиторий они не попали. После проверки их можно отозвать:

- GitHub → Settings → Developer settings → Personal access tokens;
- Cloudflare → My Profile → API Tokens → Delete.

Секрет вебхука лежит в `bot/.webhook_secret` (в git не попадает).
