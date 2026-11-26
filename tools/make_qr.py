#!/usr/bin/env python3
"""Генерирует матрицу QR-кода бота для картинок расписания.

    pip install segno
    python3 tools/make_qr.py

Результат — docs/assets/qr.js: размер и строки из 0/1. Приложение рисует
модули само, поэтому QR остаётся резким на любом масштабе и не тянет
внешних картинок.
"""
from __future__ import annotations

import json
from pathlib import Path

import segno

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "assets" / "qr.js"
URL = "https://t.me/spbgti_raspisanie_bot"


def main() -> None:
    # H — максимальная коррекция: можно перекрыть центр логотипом Telegram.
    qr = segno.make(URL, error="h", micro=False)
    rows = ["".join("1" if m else "0" for m in row) for row in qr.matrix]
    size = len(rows)
    assert all(len(r) == size for r in rows), "матрица должна быть квадратной"
    payload = {"url": URL, "size": size, "rows": rows}
    OUT.write_text(
        "/* QR-код бота. Сгенерирован tools/make_qr.py — руками не править. */\n"
        f"window.FEM_QR = {json.dumps(payload, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"ok {OUT} {size}x{size}")


if __name__ == "__main__":
    main()
