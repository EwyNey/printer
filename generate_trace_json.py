#!/usr/bin/env python3
# coding: utf-8

import csv
import json
import os
import re
import sys
from collections import defaultdict, namedtuple

Task = namedtuple("Task", ["start", "end", "thread", "args", "orig_args", "overhead_duration_us", "color", "idx"])

INT_RE = re.compile(r"^-?\d+$")
FLOAT_RE = re.compile(r"^-?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$")

def _parse_number_like(s):
    """Попытка привести к int/float или вернуть строку."""
    if s is None:
        return None
    s = s.strip()
    if s == "":
        return s
    if INT_RE.match(s):
        try:
            return int(s)
        except:
            pass
    if FLOAT_RE.match(s):
        try:
            return float(s)
        except:
            pass
    return s

def _convert_color(raw):
    if raw is None:
        return None
    raw = raw.strip()
    if raw == "":
        return None
    # try int decimal
    try:
        return int(raw)
    except:
        pass
    # hex like #ff00aa or ff00aa
    if raw.startswith("#"):
        raw2 = raw.lstrip("#")
        try:
            return int(raw2, 16)
        except:
            return None
    # try hex without #
    try:
        return int(raw, 16)
    except:
        return None

def _format_name_with_args(name_fmt, args_list):
    """
    Попытка сделать printf-подобное форматирование.
    Преобразуем каждый аргумент в int/float/str по heuristic, затем применяем оператор %.
    Если не получилось — делаем поэлементную замену для %s/%d/%f как fallback.
    """
    if name_fmt is None:
        return ""
    if args_list is None or len(args_list) == 0:
        # нет аргументов — просто вернуть строку как есть
        return name_fmt

    # подготовим список аргументов для подстановки
    converted = []
    for a in args_list:
        # уже строк; попытаемся привести:
        v = _parse_number_like(a)
        converted.append(v)

    # Попытка 1: напрямую использовать Python % (поддерживает многие printf-форматы)
    try:
        # для одиночного аргумента не ставим tuple
        if len(converted) == 1:
            return name_fmt % converted[0]
        else:
            return name_fmt % tuple(converted)
    except Exception:
        pass

    # Fallback: последовательная замена %d, %f, %s в порядке следования
    out = name_fmt
    arg_idx = 0
    # regex на простые спецификаторы (учитываем %% как literal)
    spec_re = re.compile(r"%(?:%|(?:-?\d*(?:\.\d+)?[hlL]?([diuoxXfFeEgGcs])))")
    # Но проще: пройдем по шаблону и заменим только %d, %f, %s (и %% -> %)
    def repl_match(m):
        nonlocal arg_idx, out
        tok = m.group(0)
        if tok == "%%":
            return "%"
        if arg_idx >= len(converted):
            return tok  # нет аргумента — оставим как есть
        val = converted[arg_idx]
        arg_idx += 1
        if tok.endswith("d") or tok.endswith("i") or tok.endswith("u") or tok.endswith("o") or tok.endswith("x") or tok.endswith("X"):
            try:
                return str(int(val))
            except:
                return str(val)
        if tok.endswith("f") or tok.endswith("F") or tok.endswith("e") or tok.endswith("E") or tok.endswith("g") or tok.endswith("G"):
            try:
                return str(float(val))
            except:
                return str(val)
        # default to string
        return str(val)

    # заменяем только спецсимволы %d, %f, %s и %%
    out = re.sub(r"(%%|%[-+ 0-9.#]*[diuoxXfFeEgGcs])", repl_match, name_fmt)
    return out

def parse_input(path):
    tasks = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            # skip empty lines
            if not row or all(not c.strip() for c in row):
                continue
            # minimal required cols: start,end,thread_id,name
            if len(row) < 4:
                print(f"Skipping invalid line {i+1}: {row}", file=sys.stderr)
                continue
            # parse times
            try:
                start = float(row[0].strip())
                end = float(row[1].strip())
            except Exception as e:
                print(f"Bad times on line {i+1}: {row[:2]} -> {e}", file=sys.stderr)
                continue
            thread = row[2].strip()
            name_fmt = row[3].strip()

            # overhead_duration is column 4 (index 4) if present
            overhead_duration_us = None
            if len(row) >= 5:
                rawov = row[4].strip()
                if rawov != "":
                    try:
                        overhead_duration_us = float(rawov)
                        if overhead_duration_us < 0:
                            overhead_duration_us = None
                    except:
                        overhead_duration_us = None

            # color is column 5 (index 5) if present
            color = None
            if len(row) >= 6:
                rawcolor = row[5].strip()
                color = _convert_color(rawcolor)

            # remaining columns (6+) are args (could be zero)
            orig_args = []
            if len(row) > 6:
                # take all remaining columns as individual args
                orig_args = [c for c in row[6:]]
            else:
                # maybe args provided as a single column (comma-separated) in column 6 (index 6) — not used here by default
                orig_args = []

            # also accept case where args are provided in column 6 as a JSON-like array or as semicolon/comma separated single cell
            # If there's exactly one extra column and it contains commas or brackets, try to split/parse it.
            if len(row) == 7:
                single = row[6].strip()
                if single.startswith("[") and single.endswith("]"):
                    # try JSON parse
                    try:
                        import ast
                        parsed = ast.literal_eval(single)
                        if isinstance(parsed, (list, tuple)):
                            orig_args = [str(x) for x in parsed]
                    except Exception:
                        # fallback: split by comma
                        orig_args = [p.strip() for p in re.split(r'\s*,\s*', single) if p.strip()!='']
                elif "," in single:
                    orig_args = [p.strip() for p in single.split(",") if p.strip()!='']

            # produce formatted args string (to put into JSON as 'args' field)
            try:
                formatted = _format_name_with_args(name_fmt, orig_args)
            except Exception as e:
                formatted = name_fmt

            tasks.append(Task(start, end, thread, formatted, orig_args, overhead_duration_us, color, i))
    return tasks

def export_json(tasks, out_dir):
    if not tasks:
        print("No tasks to export.", file=sys.stderr)
        return
    os.makedirs(out_dir, exist_ok=True)
    global_start = min(t.start for t in tasks)
    global_end = max(t.end for t in tasks)
    threads = defaultdict(list)
    for t in tasks:
        threads[t.thread].append({
            "start": t.start,
            "end": t.end,
            # 'args' here is the formatted name string (result of name + args)
            "args": t.args,
            # keep original args array too (useful for downstream)
            "orig_args": t.orig_args,
            "overhead_duration_us": t.overhead_duration_us,
            "color": t.color
        })
    data = {
        "global_start": global_start,
        "global_end": global_end,
        "threads": [
            {"id": thread, "tasks": tl}
            for thread, tl in threads.items()
        ]
    }
    out_path = os.path.join(out_dir, "trace.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Wrote {out_path}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python timeline_to_html_zoom.py input.csv [outdir]")
        sys.exit(1)
    inp = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) >= 3 else "static"
    tasks = parse_input(inp)
    export_json(tasks, outdir)

if __name__ == "__main__":
    main()
