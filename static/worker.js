// worker.js
// Parses trace and computes per-thread assigned rows and density histograms (bins).
// Input: { cmd:'process', data: traceJson, config: {...} }
// Output: { cmd:'done', threadLayouts: [...], total_rows, cfg }

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'process') {
    try {
      const trace = msg.data;
      const cfg = msg.config || {};
      const width_px = cfg.width_px;
      const left_margin = cfg.left_margin;
      const header_h = cfg.header_h;
      const row_height = cfg.row_height;
      const row_padding = cfg.row_padding;
      const track_spacing = cfg.track_spacing;
      const global_start = cfg.global_start;
      const global_end = cfg.global_end;

      // binning configuration for density graph (per-thread)
      const BIN_COUNT = cfg.binCount || 512; // tuneable: number of time bins for density
      const timeSpan = Math.max(1, (global_end - global_start));
      const binWidthUs = timeSpan / BIN_COUNT;

      function timeToBinIndex(t_us) {
        let idx = Math.floor((t_us - global_start) / binWidthUs);
        if (idx < 0) idx = 0;
        if (idx >= BIN_COUNT) idx = BIN_COUNT - 1;
        return idx;
      }

      // assignRows as greedy layering (pack into row numbers within a thread)
      function assignRows(tasks) {
        const arr = (tasks || []).slice().sort((a,b)=> a.start - b.start || a.end - b.end);
        const rowsEnd = [];
        const assigned = [];
        for (const t of arr) {
          let placed = false;
          for (let r = 0; r < rowsEnd.length; ++r) {
            if (rowsEnd[r] <= t.start) {
              rowsEnd[r] = t.end;
              assigned.push({task: t, row: r});
              placed = true;
              break;
            }
          }
          if (!placed) {
            rowsEnd.push(t.end);
            assigned.push({task: t, row: rowsEnd.length - 1});
          }
        }
        return {assigned, rowsCount: rowsEnd.length};
      }

      const threadLayouts = [];
      let total_rows = 0;

      for (const th of trace.threads || []) {
        const bins = new Uint32Array(BIN_COUNT);
        for (const t of (th.tasks || [])) {
          const b0 = timeToBinIndex(t.start);
          const b1 = timeToBinIndex(t.end);
          if (b1 - b0 <= 4) {
            for (let b = b0; b <= b1; ++b) bins[b]++;
          } else {
            bins[b0]++; bins[b1]++;
          }
        }

        const {assigned, rowsCount} = assignRows(th.tasks || []);

        const assignedMin = assigned.map(a => {
          const t = a.task;
          return {
            start: t.start,
            end: t.end,
            args: t.args,
            color: (t.color === undefined) ? null : t.color,
            overheads: t.overheads || null,
            overhead_duration_us: (t.overhead_duration_us === undefined) ? null : t.overhead_duration_us,
            row: a.row
          };
        });

        threadLayouts.push({
          id: th.id,
          assigned: assignedMin,
          rowsCount: rowsCount,
          densityBins: Array.from(bins),
          binCount: BIN_COUNT,
          binWidthUs,
          binStartUs: global_start
        });

        total_rows += rowsCount;
      }

      self.postMessage({ cmd: 'done', threadLayouts, total_rows, cfg });
    } catch (e) {
      self.postMessage({ cmd: 'error', message: String(e) });
    }
  }
});
