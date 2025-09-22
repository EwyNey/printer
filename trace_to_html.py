#!/usr/bin/env python3

import csv
import sys
import html
import math
from collections import defaultdict, namedtuple

Task = namedtuple("Task", ["start", "end", "thread", "args", "color", "orig_line", "idx"])

def parse_input(path):
    tasks = []
    with open(path, newline='', encoding='utf-8') as f:
        # use csv to respect quoted fields & commas in args
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if not row:
                continue
            # tolerate rows with trailing commas/spaces
            # expect at least 4 columns
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
            color = None
            if len(row) >= 5:
                raw = row[4].strip()
                if raw != "":
                    try:
                        color = int(raw)
                    except:
                        # allow color like "#ff8800" - try parse hex
                        if raw.startswith("#"):
                            try:
                                color = int(raw.lstrip("#"), 16)
                            except:
                                color = None
                        else:
                            color = None
            tasks.append(Task(start, end, thread, args, color, row, i))
    return tasks

# deterministic color: map integer -> HSL; or hash args -> integer -> HSL
def color_from_int(x):
    # convert to 0..360 hue
    h = (x * 2654435761) & 0xFFFFFFFF  # mix
    hue = (h % 360)
    sat = 60 + (h >> 8) % 20  # 60..79
    light = 45 + (h >> 16) % 10  # 45..54
    return f"hsl({hue} {sat}% {light}%)"

def color_from_string(s):
    # simple hash
    h = 1469598103934665603  # fnv offset basis
    for ch in s:
        h ^= ord(ch)
        h *= 1099511628211
        h &= 0xFFFFFFFFFFFFFFFF
    return color_from_int(h & 0xFFFFFFFF)

def assign_rows_per_thread(tasks):
    # tasks: list of Task for a single thread
    # We'll assign each task a row (vertical) so that tasks on same row do not overlap.
    # Greedy: keep list of end times per row (last_end). For each task by start, find first row with last_end <= start.
    tasks_sorted = sorted(tasks, key=lambda t: (t.start, t.end))
    rows_end = []  # end time for each row
    assigned = []
    for t in tasks_sorted:
        placed = False
        for r_idx, last_end in enumerate(rows_end):
            if last_end <= t.start:
                rows_end[r_idx] = t.end
                assigned.append((t, r_idx))
                placed = True
                break
        if not placed:
            rows_end.append(t.end)
            assigned.append((t, len(rows_end)-1))
    # return list with row index and number of rows
    return assigned, len(rows_end)

def generate_html(tasks, out_path):
    # group by thread
    threads = defaultdict(list)
    for t in tasks:
        threads[t.thread].append(t)

    # compute global min/max time
    if not tasks:
        print("No tasks found.", file=sys.stderr)
        return
    global_start = min(t.start for t in tasks)
    global_end = max(t.end for t in tasks)
    if global_end == global_start:
        global_end = global_start + 1

    # layout parameters
    width_px = 1400
    left_margin = 200
    row_height = 20
    row_padding = 6
    track_spacing = 12
    header_h = 40

    # for each thread compute assigned rows
    thread_layout = {}  # thread -> ([(task,row),...], rows_count)
    total_rows = 0
    for thread, tlist in threads.items():
        assigned, rows_count = assign_rows_per_thread(tlist)
        thread_layout[thread] = (assigned, rows_count)
        total_rows += rows_count

    total_height = header_h + total_rows * (row_height + row_padding) + len(thread_layout) * track_spacing + 100

    # time -> x
    def time_to_x(us):
        rel = (us - global_start) / (global_end - global_start)
        return left_margin + float(rel * (width_px - left_margin - 40))

    # assemble SVG rectangles with data for JS
    svg_items = []
    y_cursor = header_h
    thread_order = sorted(thread_layout.keys())  # deterministic order
    thread_blocks = []
    row_index_global = 0
    for thread in thread_order:
        assigned, rows_count = thread_layout[thread]
        # header for thread block
        block_id = f"thread-{html.escape(thread).replace(' ','_')}-{row_index_global}"
        thread_blocks.append({
            "id": block_id,
            "thread": thread,
            "y": y_cursor,
            "rows": rows_count,
            "start_row_global": row_index_global
        })
        # header rectangle + label
        svg_items.append({
            "type": "thread_header",
            "x": 0,
            "y": y_cursor,
            "w": width_px,
            "h": row_height + row_padding,
            "thread": thread,
            "id": block_id
        })
        y_for_rows = y_cursor + row_height + row_padding/2
        # draw each assigned task
        for t, r in assigned:
            gx = time_to_x(t.start)
            gW = max(2, time_to_x(t.end) - gx)
            # compute y: each row within thread gets y based on row_index_global + r
            y = header_h + (row_index_global + r) * (row_height + row_padding) + (len(thread_blocks)-1)*track_spacing
            # determine color
            if t.color is not None:
                fill = color_from_int(int(t.color) & 0xFFFFFFFF)
            else:
                fill = color_from_string(t.args or str(t.idx))
            tooltip = f"{t.thread}\\n{t.start} - {t.end} μs\\n{t.args}"
            svg_items.append({
                "type": "task",
                "x": gx,
                "y": y,
                "w": gW,
                "h": row_height,
                "fill": fill,
                "tooltip": tooltip,
                "args": t.args,
                "start": t.start,
                "end": t.end,
                "thread": t.thread,
                "idx": t.idx,
                "row_local": r,
                "row_global": row_index_global + r
            })
        # increment row_index_global
        row_index_global += rows_count
        y_cursor = header_h + row_index_global * (row_height + row_padding) + len(thread_blocks)*track_spacing

    # produce HTML
    html_parts = []
    html_parts.append(f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Timeline</title>
<style>
body {{ font-family: Arial, Helvetica, sans-serif; margin: 8px; }}
.header {{ margin-bottom: 8px; }}
.thread-header {{ cursor: pointer; user-select: none; font-weight: bold; }}
.legend {{ font-size: 12px; color: #444; }}
svg {{ border: 1px solid #ddd; background: #fff; }}
.task-rect {{ stroke: rgba(0,0,0,0.08); stroke-width: 1; rx:3; ry:3; }}
.hidden {{ display: none; }}
.tooltip {{
  position: absolute;
  pointer-events: none;
  background: rgba(0,0,0,0.8);
  color: white; padding: 6px; border-radius: 4px; font-size: 12px;
  white-space: pre;
}}
.controls {{ margin-bottom: 8px; }}
</style>
</head>
<body>
<div class="header">
  <div class="controls">
    <button onclick="collapseAll(true)">Свернуть все</button>
    <button onclick="collapseAll(false)">Развернуть все</button>
    &nbsp;|&nbsp;
    <span class="legend">Временной диапазон: {global_start} — {global_end} μs</span>
  </div>
  <div>Файл: {html.escape(sys.argv[1] if len(sys.argv)>1 else "input")}</div>
</div>

<div id="svgwrap" style="position:relative;">
<svg id="timeline" width="{width_px}" height="{total_height}" xmlns="http://www.w3.org/2000/svg" >
  <defs>
    <style type="text/css"><![CDATA[
      .thread-label {{ font-size:12px; fill:#111; }}
      .time-label {{ font-size:11px; fill:#666; }}
    ]]></style>
  </defs>
""")

    # draw time ruler at top
    ticks = 8
    for i in range(ticks+1):
        t_us = global_start + (global_end-global_start)*i/ticks
        x = time_to_x(t_us)
        html_parts.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{header_h-6}" stroke="#eee" />')
        html_parts.append(f'<text x="{x+3}" y="{header_h-10}" class="time-label">{float(t_us)} μs</text>')

    # draw thread headers and tasks
    for item in svg_items:
        if item["type"] == "thread_header":
            y = item["y"]
            h = item["h"]
            idattr = html.escape(item["id"])
            thread_name = html.escape(item["thread"])
            html_parts.append(f'<g class="thread-block" data-block="{idattr}">')
            html_parts.append(f'<rect x="0" y="{y}" width="{width_px}" height="{h}" fill="#f8f8f8" />')
            html_parts.append(f'<text x="8" y="{y + h/1.8}" class="thread-label" onclick="toggleThread(\'{idattr}\')">▶ {thread_name}</text>')
            html_parts.append('</g>')
        elif item["type"] == "task":
            x = item["x"]; y = item["y"]; w = item["w"]; h = item["h"]
            fill = item["fill"]
            tid = html.escape(item["thread"]).replace(" ","_")
            # attach data attributes for thread id: we'll map to block by computing block boundaries in JS
            html_parts.append(f'<rect class="task-rect task" x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" data-thread="{html.escape(item["thread"])}" data-start="{item["start"]}" data-end="{item["end"]}" data-args="{html.escape(item["args"])}" />')
            # short text label if width allows
            label = html.escape(item["args"][:30])
            if w > 40:
                html_parts.append(f'<text x="{x+4}" y="{y+h*0.7}" class="task-label" style="font-size:11px">{label}</text>')
    # close svg
    html_parts.append("</svg>")
    # tooltip div
    html_parts.append('<div id="tooltip" class="tooltip" style="display:none;"></div>')
    html_parts.append("</div>")

    # JS: collapse by hiding rows whose y within block range
    # We'll compute the Y extents of thread headers and rows here by reading SVG elements.
    html_parts.append("""
<script>
(function(){
  const svg = document.getElementById('timeline');
  const tooltip = document.getElementById('tooltip');

  // Build thread blocks by scanning header texts (▶ label). Each header's text contains thread name.
  // We'll group task rects by nearest header above them.
  const headers = [];
  // header rects and label text nodes are in svg: find text nodes with "▶ "
  const textNodes = svg.querySelectorAll('text');
  for (let t of textNodes) {
    if (t.textContent && t.textContent.startsWith('▶ ')) {
      headers.push({text: t.textContent.substring(2), x: t.getAttribute('x'), y: parseFloat(t.getAttribute('y')), node: t});
    }
  }
  // get all tasks
  const tasks = Array.from(svg.querySelectorAll('rect.task'));
  // compute header y positions and map tasks into blocks by finding header with greatest y less than task.y
  let headerInfo = headers.map(h => {
    return {name: h.text, y: h.y, id: h.node.getAttribute('onclick') || h.text};
  });

  // a simpler approach: find all header rects (fill #f8f8f8) and compute their y
  const headerRects = Array.from(svg.querySelectorAll('rect')).filter(r => r.getAttribute('fill') === '#f8f8f8');
  const blocks = [];
  for (let hr of headerRects) {
    const y = parseFloat(hr.getAttribute('y'));
    // find label text near that y
    let label = null;
    for (let t of textNodes) {
      const ty = parseFloat(t.getAttribute('y') || -9999);
      if (Math.abs(ty - (y + parseFloat(hr.getAttribute('height'))/1.8)) < 6) {
        label = t.textContent.replace('▶ ','');
        break;
      }
    }
    blocks.push({y: y, h: parseFloat(hr.getAttribute('height')), label: label, headerRect: hr});
  }
  // sort blocks by y
  blocks.sort((a,b)=>a.y-b.y);

  // for each block compute range of y that belongs to it: from header bottom to just before next header
  for (let i=0;i<blocks.length;i++) {
    const b = blocks[i];
    const top = b.y + b.h;
    const bottom = (i+1<blocks.length) ? blocks[i+1].y : svg.getAttribute('height');
    b.top = top;
    b.bottom = bottom;
    // also add a button to header text to allow toggle
    // find text node again and attach onclick
    for (let t of textNodes) {
      const ty = parseFloat(t.getAttribute('y') || -9999);
      if (Math.abs(ty - (b.y + b.h/1.8)) < 6) {
        t.style.cursor = 'pointer';
        t.addEventListener('click', ()=>{
          toggleBlock(b);
        });
        b.textNode = t;
        break;
      }
    }
  }

  function toggleBlock(block) {
    const hidden = block.hidden = !block.hidden;
    // update triangle symbol
    if (block.textNode) {
      block.textNode.textContent = (hidden ? '▶ ' : '▼ ') + (block.label||'');
    }
    // toggle visibility of all tasks whose center y is between top and bottom
    for (let r of tasks) {
      const ry = parseFloat(r.getAttribute('y')) + parseFloat(r.getAttribute('height'))/2;
      if (ry >= block.top && ry < block.bottom) {
        r.style.display = hidden ? 'none' : '';
        // also hide any sibling text labels (task-label)
        // find next sibling text with same x ~ r.x+4 and y ~ r.y+...
        // simple: hide text elements that overlap vertical range
      }
    }
    // hide text nodes overlapping area
    const textEls = svg.querySelectorAll('text.task-label, text');
    for (let t of textEls) {
      const ty = parseFloat(t.getAttribute('y')||-9999);
      if (ty >= block.top && ty < block.bottom) {
        t.style.display = hidden ? 'none' : '';
      }
    }
  }

  window.collapseAll = function(collapse) {
    for (let b of blocks) {
      if (b.hidden === undefined) b.hidden = false;
      if (collapse !== undefined) b.hidden = collapse;
      if (b.textNode) b.textNode.textContent = (b.hidden ? '▶ ' : '▼ ') + (b.label||'');
      for (let r of tasks) {
        const ry = parseFloat(r.getAttribute('y')) + parseFloat(r.getAttribute('height'))/2;
        if (ry >= b.top && ry < b.bottom) {
          r.style.display = b.hidden ? 'none' : '';
        }
      }
      const textEls = svg.querySelectorAll('text');
      for (let t of textEls) {
        const ty = parseFloat(t.getAttribute('y')||-9999);
        if (ty >= b.top && ty < block.bottom) {
          t.style.display = b.hidden ? 'none' : '';
        }
      }
    }
  }

  // tooltip behavior
  svg.addEventListener('mousemove', function(ev){
    const pt = getMousePos(svg, ev);
    let target = ev.target;
    if (target && target.classList && target.classList.contains('task')) {
      const args = target.getAttribute('data-args') || '';
      const start = target.getAttribute('data-start');
      const end = target.getAttribute('data-end');
      tooltip.style.display = 'block';
      tooltip.textContent = args + "\\n" + start + " - " + end + " μs";
      // place tooltip near mouse
      tooltip.style.left = (ev.pageX + 12) + 'px';
      tooltip.style.top = (ev.pageY + 12) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  });

  svg.addEventListener('mouseleave', function(){ tooltip.style.display='none'; });

  function getMousePos(svg, evt) {
    var CTM = svg.getScreenCTM();
    return {
      x: (evt.clientX - CTM.e) / CTM.a,
      y: (evt.clientY - CTM.f) / CTM.d
    };
  }
})();
</script>
</body>
</html>
""")

    with open(out_path, "w", encoding="utf-8") as fo:
        fo.write("\n".join(html_parts))
    print(f"Wrote {out_path}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python timeline_to_html.py input.csv [output.html]")
        sys.exit(1)
    inp = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) >=3 else "timeline.html"
    tasks = parse_input(inp)
    generate_html(tasks, out)

if __name__ == "__main__":
    main()
