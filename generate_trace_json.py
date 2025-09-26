#!/usr/bin/env python3

import csv
import json
import os
import sys
from collections import defaultdict, namedtuple

Task = namedtuple("Task", ["start", "end", "thread", "args", "overhead_duration_us", "color", "idx"])

def parse_input(path):
    tasks = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if not row or all(not c.strip() for c in row):
                continue
            if len(row) < 4:
                print(f"Skipping invalid line {i+1}: {row}", file=sys.stderr)
                continue
            try:
                start = float(row[0].strip())
                end = float(row[1].strip())
            except Exception as e:
                print(f"Bad times on line {i+1}: {row[:2]} -> {e}", file=sys.stderr)
                continue
            thread = row[2].strip()
            args = row[3].strip()
            overhead_duration_us = None
            if len(row) > 5:
                rawov = row[5].strip()
                if rawov != "":
                    try:
                        overhead_duration_us = float(rawov)
                        if overhead_duration_us < 0:
                            overhead_duration_us = None
                    except:
                        overhead_duration_us = None
            color = None
            if len(row) >= 6:
                raw = row[5].strip()
                if raw != "":
                    try:
                        color = int(raw)
                    except:
                        if raw.startswith("#"):
                            try:
                                color = int(raw.lstrip("#"), 16)
                            except:
                                color = None
                        else:
                            color = None
            tasks.append(Task(start, end, thread, args, overhead_duration_us, color, i))
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
            "args": t.args,
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
        print("Usage: python timeline_to_html_zoom.py input.csv [output.html]")
        sys.exit(1)
    inp = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) >= 3 else "static"
    tasks = parse_input(inp)
    export_json(tasks, outdir)

if __name__ == "__main__":
    main()
