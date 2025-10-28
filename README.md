# printer

Usage:
    python timeline_to_html.py input.txt [output.html]

Input format:
    start_us,end_us,thread_id,args[,color]

- start_us, end_us: integers (microseconds)
- thread_id: string (identifies thread id)
- args: string (may contain commas; use quotes in CSV)
- color: optional integer (if present, used to derive color)

Output:
    HTML file with embedded SVG timeline and simple JS controls to collapse/expand threads.



How to run (important):
$ python generate_trace_json.py input.csv static
$ cd static
$ python -m http.server 8000
