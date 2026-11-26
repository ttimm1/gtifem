#!/usr/bin/env python3
"""Разворачивает бота на Cloudflare Workers и настраивает Telegram.

    CLOUDFLARE_API_TOKEN=... BOT_TOKEN=... python3 bot/deploy.py

Что делает:
 1. проверяет токен Cloudflare и находит аккаунт;
 2. создаёт KV-хранилище FEM_USERS (если его нет);
 3. заливает bot/worker.js как Worker;
 4. прописывает переменные WEBAPP_URL / DATA_URL;
 5. ставит секреты BOT_TOKEN и WEBHOOK_SECRET;
 6. включает cron (утро/вечер);
 7. регистрирует вебхук, команды и кнопку меню в Telegram.

Повторный запуск безопасен: всё обновляется на месте.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "bot" / "worker.js"

API = "https://api.cloudflare.com/client/v4"
SCRIPT = "fem-schedule-bot"
KV_TITLE = "FEM_USERS"
WEBAPP_URL = "https://ttimm1.github.io/gtifem/"
DATA_URL = "https://ttimm1.github.io/gtifem/data"


def call(method: str, url: str, token: str, payload=None, raw=None, content_type="application/json"):
    data = None
    if raw is not None:
        data = raw
    elif payload is not None:
        data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            body = res.read().decode()
            return res.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as err:
        body = err.read().decode()
        try:
            return err.code, json.loads(body)
        except json.JSONDecodeError:
            return err.code, {"raw": body}


def cf(method, path, token, **kw):
    status, body = call(method, API + path, token, **kw)
    if not body.get("success", False):
        errors = body.get("errors") or [body]
        raise RuntimeError(f"Cloudflare {method} {path}: {status} {errors}")
    return body.get("result")


def multipart(fields: dict[str, str], file_field: str, filename: str, content: bytes):
    boundary = "----fem" + secrets.token_hex(12)
    parts = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/javascript+module\r\n\r\n".encode()
        + content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def tg(bot_token: str, method: str, payload=None):
    url = f"https://api.telegram.org/bot{bot_token}/{method}"
    req = urllib.request.Request(url, data=json.dumps(payload or {}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        return json.loads(err.read().decode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("CLOUDFLARE_API_TOKEN", ""))
    ap.add_argument("--bot-token", default=os.environ.get("BOT_TOKEN", ""))
    ap.add_argument("--account", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""))
    ap.add_argument("--webapp", default=WEBAPP_URL)
    ap.add_argument("--data", default=DATA_URL)
    ap.add_argument("--worker", default=SCRIPT)
    ap.add_argument("--no-telegram", action="store_true", help="не трогать настройки бота в Telegram")
    args = ap.parse_args()

    if not args.token:
        print("Нужен CLOUDFLARE_API_TOKEN", file=sys.stderr)
        return 2
    if not WORKER.exists():
        print("Нет bot/worker.js", file=sys.stderr)
        return 2

    print("→ проверяю токен Cloudflare…")
    accounts = cf("GET", "/accounts?per_page=50", args.token)
    if not accounts:
        print("У токена нет доступа к аккаунтам", file=sys.stderr)
        return 2
    account = None
    for a in accounts:
        if args.account and a["id"] != args.account:
            continue
        account = a
        break
    if not account:
        print("Аккаунт не найден", file=sys.stderr)
        return 2
    acc = account["id"]
    print(f"  аккаунт: {account.get('name')} ({acc})")

    print("→ KV-хранилище…")
    namespaces = cf("GET", f"/accounts/{acc}/storage/kv/namespaces?per_page=100", args.token)
    ns = next((n for n in namespaces if n["title"] == KV_TITLE), None)
    if not ns:
        ns = cf("POST", f"/accounts/{acc}/storage/kv/namespaces", args.token, payload={"title": KV_TITLE})
        print(f"  создано: {ns['id']}")
    else:
        print(f"  уже есть: {ns['id']}")

    print("→ заливаю Worker…")
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2026-01-01",
        "bindings": [
            {"type": "kv_namespace", "name": "USERS", "namespace_id": ns["id"]},
            {"type": "plain_text", "name": "WEBAPP_URL", "text": args.webapp},
            {"type": "plain_text", "name": "DATA_URL", "text": args.data},
        ],
    }
    body, ctype = multipart({"metadata": json.dumps(metadata)}, "worker.js", "worker.js", WORKER.read_bytes())
    status, result = call("PUT", f"{API}/accounts/{acc}/workers/scripts/{args.worker}", args.token, raw=body, content_type=ctype)
    if not result.get("success"):
        print("Ошибка загрузки:", status, result.get("errors"), file=sys.stderr)
        return 1

    print("→ секреты…")
    for name, value in (("BOT_TOKEN", args.bot_token), ("WEBHOOK_SECRET", secrets.token_hex(16))):
        if name == "BOT_TOKEN" and not value:
            print("  BOT_TOKEN не передан — пропускаю", file=sys.stderr)
            continue
        if name == "WEBHOOK_SECRET":
            existing = Path(ROOT / "bot" / ".webhook_secret")
            value = existing.read_text().strip() if existing.exists() else value
            existing.write_text(value)
        s, r = call(
            "PUT",
            f"{API}/accounts/{acc}/workers/scripts/{args.worker}/secrets",
            args.token,
            payload={"name": name, "text": value, "type": "secret_text"},
        )
        if not r.get("success"):
            print(f"  {name}: ошибка {r.get('errors')}", file=sys.stderr)

    print("→ cron…")
    body = json.dumps({"crons": ["0 5 * * *", "0 17 * * *"]}).encode()
    status, result = call(
        "PUT", f"{API}/accounts/{acc}/workers/scripts/{args.worker}/schedules", args.token, raw=body
    )
    print("  ", "ok" if result.get("success", True) else result.get("errors"))

    sub = cf("GET", f"/accounts/{acc}/workers/subdomain", args.token)
    subdomain = sub.get("subdomain") if isinstance(sub, dict) else None
    worker_url = f"https://{args.worker}.{subdomain}.workers.dev" if subdomain else None
    print(f"→ адрес: {worker_url or 'нет workers.dev поддомена — включи его в панели Cloudflare'}")

    if args.no_telegram or not args.bot_token:
        print("Telegram пропущен (нет BOT_TOKEN или --no-telegram)")
        return 0

    print("→ настраиваю Telegram…")
    webhook_secret = (ROOT / "bot" / ".webhook_secret").read_text().strip()
    hook = f"{worker_url}/telegram"
    r = tg(args.bot_token, "setWebhook", {
        "url": hook,
        "secret_token": webhook_secret,
        "allowed_updates": ["message"],
        "drop_pending_updates": False,
    })
    print("  webhook:", r.get("ok"), r.get("description", ""))

    r = tg(args.bot_token, "setMyCommands", {"commands": [
        {"command": "start", "description": "Открыть приложение"},
        {"command": "today", "description": "Пары на сегодня"},
        {"command": "week", "description": "Пары на неделю"},
        {"command": "stop", "description": "Отключить утреннюю сводку"},
        {"command": "help", "description": "Помощь"},
    ]})
    print("  команды:", r.get("ok"))

    r = tg(args.bot_token, "setChatMenuButton", {"menu_button": {
        "type": "web_app", "text": "Расписание", "web_app": {"url": args.webapp},
    }})
    print("  кнопка меню:", r.get("ok"), r.get("description", ""))

    r = tg(args.bot_token, "setMyShortDescription", {
        "short_description": "Расписание ФЭМ СПбГТИ(ТУ) — красиво, на сегодня и на неделю",
    })
    print("  описание:", r.get("ok"))
    r = tg(args.bot_token, "setMyDescription", {"description":
        "Пары на сегодня, неделя и весь семестр. Открой приложение кнопкой ниже "
        "и один раз выбери группу — дальше всё само."})
    print("  about:", r.get("ok"))

    print("\nГотово.")
    print(f"  приложение: {args.webapp}")
    print(f"  бот:        {worker_url}")
    print(f"  вебхук:     {hook}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
