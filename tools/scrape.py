#!/usr/bin/env python3
"""Скрапер расписания ФЭМ СПбГТИ(ТУ) — gtifem.ru.

Сайт отдаёт расписание через AJAX POST на ту же страницу:

    POST /dekanat/raspisanie/
      special, course            -> JSON  [["6611","6611"], ...]   (группы)
      special, course, group     -> JSON  ["сентябрь", ...]         (месяцы)
      special, course, group, month -> HTML с таблицами             (пары)

Скрипт собирает каталог групп и расписание по каждой группе в JSON.

    python3 tools/scrape.py                 # всё
    python3 tools/scrape.py --limit 3       # только 3 группы (для отладки)
    python3 tools/scrape.py --iface en0     # macOS: обойти VPN-маршрут

Зависимости: lxml, requests (или только stdlib + curl, см. _post).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

from lxml import html as lxml_html

BASE = "https://gtifem.ru/dekanat/raspisanie/"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCHEDULE = DATA / "schedule"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)

MONTHS = {
    "январь": 1,
    "февраль": 2,
    "март": 3,
    "апрель": 4,
    "май": 5,
    "июнь": 6,
    "июль": 7,
    "август": 8,
    "сентябрь": 9,
    "октябрь": 10,
    "ноябрь": 11,
    "декабрь": 12,
}
MONTHS_GEN = {
    "января": 1,
    "февраля": 2,
    "марта": 3,
    "апреля": 4,
    "мая": 5,
    "июня": 6,
    "июля": 7,
    "августа": 8,
    "сентября": 9,
    "октября": 10,
    "ноября": 11,
    "декабря": 12,
}

WEEKDAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]

# Программы (отделения) и их специальности. Порядок важен для UI.
PROGRAMS = [
    ("Бакалавриат", ["Экономика", "Реклама", "Маркетинг", "Финансовый менеджмент",
                     "Производственный менеджмент", "Логистика", "Управление персоналом",
                     "Бизнес информатика", "Прикладная информатика", "Биоэкономика"]),
    ("Магистратура", ["Инновационный менеджмент"]),
    ("СПО", ["Экономика и бухгалтерский учет (по отраслям)", "Технологи"]),
]

IFACE = os.environ.get("GTIFEM_IFACE", "")


def _curl(args: list[str], timeout: int = 40, retries: int = 3) -> str:
    cmd = [
        "curl", "-sS", "-m", str(timeout),
        "-A", UA,
        "-H", "X-Requested-With: XMLHttpRequest",
        "-H", "Accept-Language: ru-RU,ru;q=0.9",
    ]
    if IFACE:
        cmd += ["--interface", IFACE]
    cmd += args
    last = None
    for attempt in range(retries):
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout
        last = out
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(
        f"curl {getattr(last, 'returncode', '?')}: {getattr(last, 'stderr', '').strip()[:200]}"
    )


def get_page() -> str:
    return _curl([BASE])


def post(**fields: str) -> str:
    args = []
    for k, v in fields.items():
        args += ["--data-urlencode", f"{k}={v}"]
    return _curl(args + [BASE])


def sleep_between(seconds: float = 0.7):
    time.sleep(seconds)


def clean(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def parse_lesson_type(subject: str) -> tuple[str, str]:
    """«Теория анализа и статистика (лек)» -> (название, 'лек')."""
    m = re.search(r"\((лек|пр|лаб|сем|кр|зач|экз)\.?\s*\)\s*$", subject, re.I)
    if not m:
        return subject.strip(), ""
    kind = m.group(1).lower()
    return subject[: m.start()].strip(), kind


def guess_year(month: int, today: date) -> int:
    """Подбираем год так, чтобы дата была рядом с сегодняшней."""
    base = date(today.year, month, 1)
    delta = (base - date(today.year, today.month, 1)).days
    if delta < -180:
        return today.year + 1
    if delta > 180:
        return today.year - 1
    return today.year


def parse_table(html_text: str, today: date) -> dict[str, dict]:
    """Возвращает {iso_date: {time, lessons:[...]}} по всем таблицам месяца."""
    days: dict[str, dict] = {}
    html_text = html_text.strip()
    if not html_text or "Не удалось" in html_text:
        return days

    doc = lxml_html.fromstring(html_text)

    for table in doc.xpath("//table"):
        caption = clean(table.xpath("string(.//caption)"))
        month = MONTHS.get(caption.lower())
        if not month:
            for name, num in MONTHS_GEN.items():
                if name in caption.lower():
                    month = num
                    break
        if not month:
            continue
        year = guess_year(month, today)

        rows = table.xpath(".//tr")
        if not rows:
            continue

        dates: list[date | None] = []
        for row in rows:
            cells = row.xpath("./td")
            if not cells:
                continue

            # В одной таблице может быть несколько «шапок» — по неделям.
            if clean(cells[0].text_content()).lower() == "дата":
                dates = []
                for cell in cells[1:]:
                    if not (cell.get("id") or "").startswith("day"):
                        dates.append(None)
                        continue
                    label = clean(cell.text_content())
                    m = re.match(r"(\d{1,2})", label)
                    try:
                        day = int(m.group(1)) if m else int(clean(cell.get("id"))[3:])
                    except (ValueError, TypeError):
                        dates.append(None)
                        continue
                    try:
                        dates.append(date(year, month, day))
                    except ValueError:
                        dates.append(None)
                continue

            if not dates:
                continue

            time_label = clean(cells[0].text_content())
            m = re.match(r"(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})", time_label)
            if not m:
                continue
            start, end = m.group(1), m.group(2)
            time_label = f"{start} – {end}"

            for idx, cell in enumerate(cells[1:]):
                if idx >= len(dates) or dates[idx] is None:
                    continue
                subject_el = cell.xpath(".//div[@class='subject']")
                subject = clean(subject_el[0].text_content()) if subject_el else ""
                if not subject:
                    continue

                aud_el = cell.xpath(".//div[@class='aud']")
                room = clean(aud_el[0].text_content()) if aud_el else ""
                room = re.sub(r"^а\.", "", room).strip()

                note = clean(cell.get("data-not") or "")

                # Преподаватель: хвост после div-ов subject/aud, без number.
                parts = []
                for node in cell.iterchildren():
                    cls = node.get("class") or ""
                    if "number" in cls:
                        continue
                    if node.tail:
                        parts.append(clean(node.tail))
                teacher = clean(" ".join(parts))
                teacher = re.sub(r"^[.\s]+", "", teacher)
                teacher = re.sub(r"\s+\.\s*\.?$", "", teacher).strip()
                if teacher in {".", ".."}:
                    teacher = ""

                title, kind = parse_lesson_type(subject)
                iso = dates[idx].isoformat()
                entry = days.setdefault(
                    iso,
                    {
                        "date": iso,
                        "weekday": dates[idx].isoweekday(),
                        "lessons": [],
                    },
                )
                lesson = {
                    "time": time_label,
                    "start": start,
                    "end": end,
                    "subject": title,
                    "type": kind,
                    "teacher": teacher,
                    "room": room,
                    "note": note,
                }
                if not any(
                    l["start"] == start and l["subject"] == title and l["room"] == room
                    for l in entry["lessons"]
                ):
                    entry["lessons"].append(lesson)

    for entry in days.values():
        entry["lessons"].sort(key=lambda l: l["start"])
    return days


def discover_groups() -> list[dict]:
    page = get_page()
    doc = lxml_html.fromstring(page)

    course_map: dict[int, set[int]] = {}
    for li in doc.xpath("//li[contains(@class,'course')][@data-course]"):
        classes = li.get("class", "").split()
        for cls in classes:
            m = re.match(r"course(\d+)$", cls)
            if m:
                course_map.setdefault(int(m.group(1)), set()).add(int(li.get("data-course")))

    # id специальности из разметки (special<ID>) -> название
    special_names: dict[int, str] = {}
    for li in doc.xpath("//li[contains(@class,'special')]"):
        a = li.xpath(".//a[@data-id]")
        if not a:
            continue
        classes = li.get("class", "").split()
        sid = None
        for cls in classes:
            m = re.match(r"special(\d+)$", cls)
            if m:
                sid = int(m.group(1))
        if sid and a[0].get("data-id"):
            special_names[int(a[0].get("data-id"))] = clean(a[0].text_content())

    groups: list[dict] = []
    seen: set[str] = set()

    for program, specialities in PROGRAMS:
        for speciality in specialities:
            courses = set()
            sid = next((k for k, v in special_names.items() if v == speciality), None)
            if sid:
                # у СПО «Технологи» в разметке курсов нет — пробуем 1..5
                courses = course_map.get(sid, set())
            if not courses:
                courses = {1, 2, 3, 4, 5}

            for course in sorted(courses):
                try:
                    raw = post(special=speciality, course=str(course))
                    sleep_between()
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! группы {speciality}/{course}: {exc}", file=sys.stderr)
                    continue
                try:
                    rows = json.loads(raw)
                except json.JSONDecodeError:
                    continue  # null / ошибка Bitrix
                if not isinstance(rows, list):
                    continue
                for item in rows:
                    if not isinstance(item, list) or len(item) < 2:
                        continue
                    name = str(item[0]).strip()
                    gid = str(item[1]).strip()
                    if not name or gid in seen:
                        continue
                    seen.add(gid)
                    groups.append(
                        {
                            "id": gid,
                            "name": name,
                            "program": program,
                            "speciality": speciality,
                            "course": course,
                        }
                    )
                    print(f"  + {program} · {speciality} · {course} к. · {name}")
    return groups


def fetch_group(group: dict, today: date, cache: bool = True) -> dict:
    gid = group["id"]
    dest = SCHEDULE / (gid.replace(",", "-") + ".json")
    if cache and dest.exists():
        try:
            cached = json.loads(dest.read_text(encoding="utf-8"))
            if cached.get("days"):
                return cached
        except json.JSONDecodeError:
            pass

    months_raw = post(special=group["speciality"], course=str(group["course"]), group=gid)
    sleep_between()
    try:
        months = json.loads(months_raw)
    except json.JSONDecodeError:
        months = []
    if not isinstance(months, list):
        months = []

    days: dict[str, dict] = {}
    for month in months:
        try:
            table = post(
                special=group["speciality"],
                course=str(group["course"]),
                group=gid,
                month=str(month),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {gid}/{month}: {exc}", file=sys.stderr)
            continue
        sleep_between()
        days.update(parse_table(table, today))

    return {
        "group": gid,
        "name": group["name"],
        "speciality": group["speciality"],
        "program": group["program"],
        "course": group["course"],
        "months": months if isinstance(months, list) else [],
        "days": sorted(days.values(), key=lambda d: d["date"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="ограничить число групп")
    parser.add_argument("--iface", default=os.environ.get("GTIFEM_IFACE", ""), help="сетевой интерфейс для curl")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--groups", default="", help="список групп через запятую")
    parser.add_argument("--skip-discovery", action="store_true", help="взять каталог из data/catalog.json")
    args = parser.parse_args()

    global IFACE
    IFACE = args.iface

    DATA.mkdir(parents=True, exist_ok=True)
    SCHEDULE.mkdir(parents=True, exist_ok=True)

    print("Каталог групп…")
    if args.skip_discovery and (DATA / "catalog.json").exists():
        groups = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))["groups"]
        groups = [{k: g[k] for k in ("id", "name", "program", "speciality", "course")} for g in groups]
        print(f"  из кэша: {len(groups)}")
    else:
        groups = discover_groups()
        payload = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "source": BASE, "groups": groups}
        (DATA / "catalog.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  каталог сохранён: {DATA / 'catalog.json'}")
    if args.groups:
        wanted = {g.strip() for g in re.split(r"[|,]", args.groups) if g.strip()}
        groups = [
            g for g in groups
            if g["id"] in wanted
            or g["name"] in wanted
            or any(part in wanted for part in g["id"].split(","))
        ]
    if args.limit:
        groups = groups[: args.limit]

    print(f"Групп: {len(groups)}")
    today = date.today()
    catalog = []
    seen_ids = set()
    for i, group in enumerate(groups, 1):
        print(f"[{i}/{len(groups)}] {group['program']} · {group['speciality']} · {group['name']}")
        sched = fetch_group(group, today, cache=not args.no_cache)
        (SCHEDULE / (group["id"].replace(",", "-") + ".json")).write_text(
            json.dumps(sched, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        catalog.append(
            {**group, "days": len(sched["days"]), "months": sched["months"],
             "lessons": sum(len(d["lessons"]) for d in sched["days"])}
        )
        seen_ids.add(group["id"])

    # Сохраняем полный каталог, обновляя статистику только по собранным группам.
    full: list[dict] = []
    if (DATA / "catalog.json").exists():
        try:
            full = json.loads((DATA / "catalog.json").read_text(encoding="utf-8")).get("groups", [])
        except json.JSONDecodeError:
            full = []
    stats = {g["id"]: g for g in catalog}
    merged = []
    for g in full or catalog:
        gid = g.get("id")
        if gid in stats:
            g = {**g, **stats[gid]}
        merged.append(g)
    payload = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": BASE,
        "groups": merged,
    }
    (DATA / "catalog.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    total_lessons = sum(g["lessons"] for g in catalog)
    print(f"Готово: {len(catalog)} групп, {total_lessons} пар, {DATA}/catalog.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
