// worker.js (optimized)
// Parses trace and computes per-thread assigned rows and density histograms (bins).
// Input: { cmd:'process', data: traceJson, config: {...} }
// Output: { cmd:'done', threadLayouts: [...], total_rows, cfg }

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || !msg.cmd) return;
  if (msg.cmd !== 'process') return;

  try {
    const trace = msg.data || {};
    const cfg = msg.config || {};
    const global_start = Number(cfg.global_start || 0);
    const global_end = Number(cfg.global_end || (global_start + 1));
    const BIN_COUNT = Number(cfg.binCount || 512);

    // binning parameters (local caches)
    const timeSpan = Math.max(1, (global_end - global_start));
    const binWidthUs = timeSpan / BIN_COUNT;

    // Inline time->bin index (fast)
    function timeToBinIdxFast(t_us) {
      // floor((t - global_start) / binWidthUs) with clamping
      const idx = Math.floor((t_us - global_start) / binWidthUs);
      if (idx < 0) return 0;
      if (idx >= BIN_COUNT) return BIN_COUNT - 1;
      return idx;
    }

    // assignRows - greedy layering but implemented with a min-heap of row end times.
    // Complexity: O(n log r) where r = resulting rowsCount.
    function assignRows(tasks) {
      if (!tasks || tasks.length === 0) return { assigned: [], rowsCount: 0 };

      // copy tasks into array and sort by start,end (in-place)
      const arr = Array.from(tasks);
      arr.sort((a,b) => {
        if (a.start < b.start) return -1;
        if (a.start > b.start) return 1;
        if (a.end < b.end) return -1;
        if (a.end > b.end) return 1;
        return 0;
      });

      const n = arr.length;
      const assigned = new Array(n);
      // Min-heap by end time. We store two parallel arrays for speed:
      const heapEnds = []; // numerical end times
      const heapIdx = [];  // row index associated with heap position
      let nextRowIdx = 0;

      // heap helpers (binary heap, 0-based)
      function heapSiftUp(idx) {
        let i = idx;
        const endVal = heapEnds[i];
        const idVal = heapIdx[i];
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heapEnds[parent] <= endVal) break;
          heapEnds[i] = heapEnds[parent];
          heapIdx[i] = heapIdx[parent];
          i = parent;
        }
        heapEnds[i] = endVal;
        heapIdx[i] = idVal;
      }
      function heapSiftDown(idx) {
        let i = idx;
        const len = heapEnds.length;
        const endVal = heapEnds[i];
        const idVal = heapIdx[i];
        while (true) {
          const l = i * 2 + 1;
          const r = l + 1;
          if (l >= len) break;
          let smallest = l;
          if (r < len && heapEnds[r] < heapEnds[l]) smallest = r;
          if (heapEnds[smallest] >= endVal) break;
          heapEnds[i] = heapEnds[smallest];
          heapIdx[i] = heapIdx[smallest];
          i = smallest;
        }
        heapEnds[i] = endVal;
        heapIdx[i] = idVal;
      }
      function heapPush(endTime, rowIndex) {
        const i = heapEnds.length;
        heapEnds.push(endTime);
        heapIdx.push(rowIndex);
        heapSiftUp(i);
      }
      function heapReplaceTop(newEnd) {
        // replace root end with newEnd and sift down; return associated row index
        const idx = heapIdx[0];
        heapEnds[0] = newEnd;
        heapSiftDown(0);
        return idx;
      }

      for (let i = 0; i < n; ++i) {
        const t = arr[i];
        const s = Number(t.start);
        const e = Number(t.end);

        if (heapEnds.length === 0 || heapEnds[0] > s) {
          // need a new row
          const row = nextRowIdx++;
          heapPush(e, row);
          assigned[i] = { task: t, row: row };
        } else {
          // reuse earliest-finishing row: replace its end and get its row index
          const row = heapReplaceTop(e);
          assigned[i] = { task: t, row: row };
        }
      }

      return { assigned, rowsCount: nextRowIdx };
    }

    const threadLayouts = [];
    let total_rows = 0;

    const threads = trace.threads || [];
    for (let ti = 0; ti < threads.length; ++ti) {
      const th = threads[ti];
      const tasks = th.tasks || [];

      // density bins using typed array for speed
      const bins = new Uint32Array(BIN_COUNT);

      // fast binning loop (inline)
      for (let k = 0; k < tasks.length; ++k) {
        const t = tasks[k];
        const s = Number(t.start);
        const e = Number(t.end);
        let b0 = Math.floor((s - global_start) / binWidthUs);
        let b1 = Math.floor((e - global_start) / binWidthUs);
        if (b0 < 0) b0 = 0;
        else if (b0 >= BIN_COUNT) b0 = BIN_COUNT - 1;
        if (b1 < 0) b1 = 0;
        else if (b1 >= BIN_COUNT) b1 = BIN_COUNT - 1;

        // heuristics: if short span, increment all bins between; else increment endpoints
        if (b1 - b0 <= 4) {
          for (let b = b0; b <= b1; ++b) bins[b] = bins[b] + 1;
        } else {
          bins[b0] = bins[b0] + 1;
          bins[b1] = bins[b1] + 1;
        }
      }

      // assign rows (greedy using min-heap)
      const { assigned, rowsCount } = assignRows(tasks);

      // minimize allocations: build assignedMin via push in a loop
      const assignedMin = new Array(assigned.length);
      for (let ai = 0; ai < assigned.length; ++ai) {
        const a = assigned[ai];
        const t = a.task;
        assignedMin[ai] = {
          start: t.start,
          end: t.end,
          args: t.args,
          color: (t.color === undefined) ? null : t.color,
          overheads: t.overheads || null,
          overhead_duration_us: (t.overhead_duration_us === undefined) ? null : t.overhead_duration_us,
          row: a.row
        };
      }

      // copy bins to plain Array for compatibility downstream
      const binsArr = Array.from(bins);

      threadLayouts.push({
        id: th.id,
        assigned: assignedMin,
        rowsCount: rowsCount,
        densityBins: binsArr,
        binCount: BIN_COUNT,
        binWidthUs,
        binStartUs: global_start
      });

      total_rows += rowsCount;
    }

    // done
    self.postMessage({ cmd: 'done', threadLayouts, total_rows, cfg });
  } catch (err) {
    self.postMessage({ cmd: 'error', message: String(err) });
  }
});
