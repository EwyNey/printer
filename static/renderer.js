// renderer.js
// High-performance canvas timeline viewer
// Main features implemented per user request:
// - Main map: thread bands with alternating colors; click header to collapse/expand
// - Collapsed threads show density-sparkline computed in worker (Perfetto-like)
// - Overhead entries become inset green fragments inside parent task (start = parent.end if overhead_duration_us)
// - Minimap: overview-only (no stream control), click to center main view, drag to reposition minimap
// - Touch: pinch-to-zoom and one-finger pan
// - WebWorker preprocessing and virtualized canvas rendering

(() => {
  // CONFIG
  const CONFIG = {
    width_px: 1400,
    left_margin: 200,
    row_height: 20,
    row_padding: 6,
    header_h: 40,
    track_spacing: 12,
    MINIMAP_W_CSS: 420,
    MINIMAP_H_CSS: 120,
    OVERHEAD_COLOR: '#4CAF50',
    TASK_TEXT_SIZE: 11,
    ALTERNATING_BG_A: '#f2f2f2',
    ALTERNATING_BG_B: '#e0e0e0'
  };

  // DOM refs
  const container = document.getElementById('svg-container');
  const mainCanvas = document.getElementById('mainCanvas');
  const rulerCanvas = document.getElementById('rulerCanvas');
  const minimapCanvas = document.getElementById('minimap');
  const tooltip = document.getElementById('tooltip');

  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnReset = document.getElementById('btnReset');
  const btnFit = document.getElementById('btnFit');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomValue = document.getElementById('zoomValue');
  const panXSlider = document.getElementById('panXSlider');
  const panXValue = document.getElementById('panXValue');
  const btnCollapseAll = document.getElementById('btnCollapseAll');
  const btnExpandAll = document.getElementById('btnExpandAll');
  const fileInput = document.getElementById('fileInput');

  // contexts and DPR
  let mainCtx, rulerCtx, miniCtx;
  let DPR = Math.max(1, window.devicePixelRatio || 1);

  // state
  let threadLayouts = []; // from worker
  let total_rows = 0;
  let global_start = 0, global_end = 1;

  let rows = []; // per-row arrays of tasks
  let rowCount = 0;

  let threadHeaders = []; // {id, headerY, headerH, threadIdx, altIndex, densityBins,...}

  let threadVisible = new Map(); // thread id -> bool

  let scale = 1.0;
  let panX = 0, panY = 0;
  let panXMin = 0, panXMax = 0, panYMin = 0, panYMax = 0;

  let renderScheduled = false;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');

  let worker = null;

  let MINIMAP_W = CONFIG.MINIMAP_W_CSS;
  let MINIMAP_H = CONFIG.MINIMAP_H_CSS;

  // helpers time <-> x (content coords)
  function timeToX(t_us) {
    const usable = (CONFIG.width_px - CONFIG.left_margin - 40);
    const rel = (t_us - global_start) / (global_end - global_start);
    return CONFIG.left_margin + rel * usable;
  }
  function xToTime(x) {
    const usable = (CONFIG.width_px - CONFIG.left_margin - 40);
    const rel = (x - CONFIG.left_margin) / usable;
    return global_start + rel * (global_end - global_start);
  }

  // resize canvases & DPR handling
  function resizeCanvases() {
    DPR = Math.max(1, window.devicePixelRatio || 1);
    const rect = container.getBoundingClientRect();
    mainCanvas.style.width = rect.width + 'px';
    mainCanvas.style.height = rect.height + 'px';
    mainCanvas.width = Math.round(rect.width * DPR);
    mainCanvas.height = Math.round(rect.height * DPR);

    rulerCanvas.style.left = '0px';
    rulerCanvas.style.top = '0px';
    rulerCanvas.style.width = rect.width + 'px';
    rulerCanvas.style.height = CONFIG.header_h + 'px';
    rulerCanvas.width = Math.round(rect.width * DPR);
    rulerCanvas.height = Math.round(CONFIG.header_h * DPR);

    const miniRect = minimapCanvas.getBoundingClientRect();
    MINIMAP_W = Math.max(80, Math.round(miniRect.width));
    MINIMAP_H = Math.max(40, Math.round(miniRect.height));
    minimapCanvas.width = Math.round(MINIMAP_W * DPR);
    minimapCanvas.height = Math.round(MINIMAP_H * DPR);

    mainCtx = mainCanvas.getContext('2d');
    mainCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    mainCtx.font = `${CONFIG.TASK_TEXT_SIZE}px Arial`;

    rulerCtx = rulerCanvas.getContext('2d');
    rulerCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    rulerCtx.font = `12px Arial`;

    miniCtx = minimapCanvas.getContext('2d');
    miniCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

    measureCtx.setTransform(1,0,0,1,0,0);
    measureCtx.font = `${CONFIG.TASK_TEXT_SIZE}px Arial`;

    // normalize minimap initial position to left/top so dragging is easier
    normalizeMinimapPosition();

    updatePanLimits();
    scheduleRender();
  }

  function normalizeMinimapPosition(){
    const cs = getComputedStyle(minimapCanvas);
    if ((!cs.left || cs.left === 'auto') && (!cs.top || cs.top === 'auto')) {
      // compute position relative to container
      const r = minimapCanvas.getBoundingClientRect();
      const cont = container.getBoundingClientRect();
      const left = r.left - cont.left;
      const top = r.top - cont.top;
      minimapCanvas.style.left = `${left}px`;
      minimapCanvas.style.top = `${top}px`;
      minimapCanvas.style.right = '';
      minimapCanvas.style.bottom = '';
    }
  }

  // pan limits clamp
  function updatePanLimits() {
    const rect = container.getBoundingClientRect();
    const vpW = rect.width, vpH = rect.height;
    const scaledW = CONFIG.width_px * scale;
    const contentHeight = Math.max(CONFIG.header_h + total_rows * (CONFIG.row_height + CONFIG.row_padding) + threadLayouts.length * CONFIG.track_spacing + 100, CONFIG.header_h + 10);
    const scaledH = contentHeight * scale;

    if (scaledW > vpW) {
      panXMin = vpW - scaledW;
      panXMax = 0;
    } else {
      const c = Math.floor((vpW - scaledW) / 2);
      panXMin = panXMax = c;
    }
    if (scaledH > vpH) {
      panYMin = vpH - scaledH;
      panYMax = 0;
    } else {
      const cY = Math.floor((vpH - scaledH) / 2);
      panYMin = panYMax = cY;
    }

    if (panX < panXMin) panX = panXMin;
    if (panX > panXMax) panX = panXMax;
    if (panY < panYMin) panY = panYMin;
    if (panY > panYMax) panY = panYMax;

    if (panXSlider) {
      panXSlider.min = Math.round(panXMin);
      panXSlider.max = Math.round(panXMax);
      panXSlider.value = Math.round(panX);
      panXValue.textContent = `${Math.round(panX)} px`;
      panXSlider.disabled = (panXMin === panXMax);
    }
  }

  // worker creation
  function createWorker() {
    try {
      worker = new Worker('worker.js');
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.cmd === 'done') {
          threadLayouts = m.threadLayouts;
          total_rows = m.total_rows;
          global_start = (m.cfg && m.cfg.global_start) ? m.cfg.global_start : global_start;
          global_end = (m.cfg && m.cfg.global_end) ? m.cfg.global_end : global_end;
          threadVisible.clear();
          for (const t of threadLayouts) threadVisible.set(t.id, true);
          buildRowsFromLayouts();
          fitToWidth();
          scheduleRender();
        } else if (m.cmd === 'error') {
          console.error('Worker error:', m.message);
        }
      });
    } catch (e) {
      console.error('Failed to create worker:', e);
      worker = null;
    }
  }

  // build rows and thread headers (including altIndex for alternating bg)
  function buildRowsFromLayouts() {
    rows = [];
    threadHeaders = [];
    let row_index_global = 0;
    let altCounter = 0;
    for (let threadIdx = 0; threadIdx < threadLayouts.length; ++threadIdx) {
      const tl = threadLayouts[threadIdx];
      const assigned = tl.assigned;
      const rowsCount = tl.rowsCount;
      const headerY = CONFIG.header_h + row_index_global * (CONFIG.row_height + CONFIG.row_padding) + threadIdx * CONFIG.track_spacing;
      const headerH = CONFIG.row_height + CONFIG.row_padding;
      threadHeaders.push({
        id: tl.id,
        headerY, headerH,
        threadIdx,
        altIndex: altCounter % 2,
        densityBins: tl.densityBins || null,
        binCount: tl.binCount || 0,
        binWidthUs: tl.binWidthUs || 0,
        binStartUs: tl.binStartUs || 0
      });
      altCounter++;
      for (const pair of assigned) {
        const x = timeToX(pair.start);
        const w = Math.max(2, timeToX(pair.end) - x);
        const y = CONFIG.header_h + (row_index_global + pair.row) * (CONFIG.row_height + CONFIG.row_padding) + threadIdx * CONFIG.track_spacing;
        const h = CONFIG.row_height;
        const color = (pair.color === null || pair.color === undefined) ? colorFromString(pair.args || '') : colorFromInt(pair.color);
        // build overheads (declared field)
        const overheadsArr = [];
        if (Array.isArray(pair.overheads) && pair.overheads.length) {
          for (const o of pair.overheads) overheadsArr.push({ start: o.start, end: o.end, args: o.args });
        }
        if (pair.overhead_duration_us && Number(pair.overhead_duration_us) > 0) {
          const ohStart = Number(pair.end);
          const ohEnd = ohStart + Number(pair.overhead_duration_us);
          if (!overheadsArr.some(x => x.start === ohStart && x.end === ohEnd)) {
            overheadsArr.push({ start: ohStart, end: ohEnd, args: (pair.args||'') + ' (ov)'});
          }
        }
        const taskObj = {
          x, w, y, h,
          start: pair.start,
          end: pair.end,
          args: pair.args,
          color,
          thread: tl.id,
          overheads: overheadsArr.length ? overheadsArr : null
        };
        const rowIndex = row_index_global + pair.row;
        if (!rows[rowIndex]) rows[rowIndex] = [];
        rows[rowIndex].push(taskObj);
      }
      row_index_global += rowsCount;
    }
    for (let r = 0; r < rows.length; ++r) if (rows[r]) rows[r].sort((a,b)=>a.x - b.x);
    rowCount = rows.length;

    // compute miniY per header
    const contentHeight = Math.max(CONFIG.header_h + total_rows * (CONFIG.row_height + CONFIG.row_padding) + threadLayouts.length * CONFIG.track_spacing + 100, CONFIG.header_h + 10);
    for (const th of threadHeaders) {
      th.miniY = Math.round((th.headerY / contentHeight) * (MINIMAP_H || CONFIG.MINIMAP_H_CSS));
    }
  }

  // color helpers
  function colorFromInt(x){
    x = Number(x) >>> 0;
    const h = (x * 2654435761) >>> 0;
    const hue = h % 360;
    const sat = 60 + ((h >> 8) % 20);
    const light = 45 + ((h >> 16) % 10);
    return `hsl(${hue} ${sat}% ${light}%)`;
  }
  function colorFromString(s){
    let h = 2166136261 >>> 0;
    for (let i=0;i<s.length;i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const hue = h % 360;
    return `hsl(${hue} 62% 52%)`;
  }

  // draw ruler
  function drawRuler() {
    const rect = container.getBoundingClientRect();
    const canvasW = rect.width;
    const h = CONFIG.header_h;

    rulerCtx.clearRect(0, 0, canvasW, h);
    // фон
    rulerCtx.fillStyle = '#fff';
    rulerCtx.fillRect(0, 0, canvasW, h);

    // --- вычислим видимый временной диапазон (в тех же единицах, что и start/end) ---
    // contentX = (screenX - panX) / scale
    const leftContentX = Math.max(0, (-panX) / scale);
    const rightContentX = Math.min(CONFIG.width_px, (canvasW - panX) / scale);
    // преобразуем contentX (координаты) в время (us)
    const leftTime = xToTime(leftContentX);
    const rightTime = xToTime(rightContentX);
    const visibleTimeSpan = Math.max(1e-12, rightTime - leftTime); // guard

    // --- выберем "красивый" шаг по времени (1-2-5 × 10^n) так, чтобы он занимал примерно targetPxPerTick пикселей ---
    const targetPxPerTick = 110; // целевой пиксель между тиками (поменяйте при желании)
    // видимый пиксельный диапазон = canvasW
    const pxPerUs = ( (timeToX(leftTime + 1) - timeToX(leftTime)) ); // content x per 1us (в контентных координатах)
    // Но проще: pxPerUs в экранных пикселях = scale * (usable / timeSpan_global)
    const usable = (CONFIG.width_px - CONFIG.left_margin - 40);
    const pxPerUsScreen = (usable / (global_end - global_start)) * scale;

    // искомый шаг по времени:
    const approxStepUs = Math.max(1e-12, (targetPxPerTick / Math.max(1e-12, pxPerUsScreen)));
    // нормализуем approxStepUs до ближайшего вида 1,2,5 × 10^n
    function niceStep(value) {
      const pow = Math.pow(10, Math.floor(Math.log10(value)));
      const d = value / pow;
      if (d <= 1) return pow;
      if (d <= 2) return 2 * pow;
      if (d <= 5) return 5 * pow;
      return 10 * pow;
    }
    const stepUs = niceStep(approxStepUs);

    // --- вычислим первый и последний тик (время) ---
    const firstTick = Math.floor(leftTime / stepUs) * stepUs;
    // количество тиков, чтобы не рисовать гигантское число
    const maxTicks = Math.ceil( (rightTime - firstTick) / stepUs ) + 2;
    // ограничение тиков (защитное)
    const HARD_MAX_TICKS = 2000;
    const ticksToRender = Math.min(maxTicks, HARD_MAX_TICKS);

    // отрисовка тиков и меток
    rulerCtx.fillStyle = '#333';
    rulerCtx.textBaseline = 'top';
    rulerCtx.font = '11px Arial';

    // линия основания
    rulerCtx.strokeStyle = '#ccc';
    rulerCtx.beginPath();
    rulerCtx.moveTo(0, h - 1);
    rulerCtx.lineTo(canvasW, h - 1);
    rulerCtx.stroke();

    // вспомогательная функция форматирования времени (поддерживает дробные значения)
    function formatTimeLabel(t) {
      // выбираем точность в зависимости от размера шага
      // если шаг < 1 -> показать 3 знака, если <0.001 -> показать больше и т.д.
      const absStep = Math.abs(stepUs);
      if (absStep >= 1) {
        // целые микросекунды
        if (Math.abs(t - Math.round(t)) < 1e-9) return String(Math.round(t)) + ' μs';
        return Number(t.toFixed(3)).toString() + ' μs';
      } else {
        // дробные: выберем количество знаков нужное для отражения шага
        const digits = Math.min(6, Math.max(0, Math.ceil(-Math.log10(absStep)) + 1));
        return Number(t.toFixed(digits)).toString() + ' μs';
      }
    }

    // рисуем тики
    for (let i = 0; i < ticksToRender; ++i) {
      const timeUs = firstTick + i * stepUs;
      if (timeUs < leftTime - 1e-12) continue;
      if (timeUs > rightTime + 1e-12) break;
      // position on screen: contentX -> screenX
      const contentX = timeToX(timeUs);
      const screenX = contentX * scale + panX;
      // skip if offscreen (safety)
      if (screenX < -50 || screenX > canvasW + 50) continue;

      // tick line (minor/major: make every 5th/10th a longer tick)
      const major = Math.abs((i % 5)) < 1e-9; // every 5 ticks major
      const tickHeight = major ? 12 : 6;
      rulerCtx.beginPath();
      rulerCtx.moveTo(screenX + 0.5, h - 1);
      rulerCtx.lineTo(screenX + 0.5, h - 1 - tickHeight);
      rulerCtx.strokeStyle = major ? '#888' : '#bbb';
      rulerCtx.stroke();

      // label for major ticks — avoid overlap: measure and skip if too close to previous label
      if (major) {
        const label = formatTimeLabel(timeUs);
        const textW = rulerCtx.measureText(label).width;
        // ensure label not drawn outside canvas
        let tx = screenX + 3;
        if (tx + textW > canvasW - 4) tx = canvasW - 4 - textW;
        if (tx < 2) tx = 2;
        rulerCtx.fillStyle = '#333';
        rulerCtx.fillText(label, tx, 6);
      }
    }

    // draw highlight of visible content in ruler (semi-transparent)
    const contentToScreen = (cx) => cx * scale + panX;
    const pxLeft = contentToScreen(leftContentX);
    const pxRight = contentToScreen(rightContentX);
    rulerCtx.fillStyle = 'rgba(100,150,250,0.12)';
    rulerCtx.fillRect(pxLeft, 2, Math.max(1, pxRight - pxLeft), Math.max(4, h - 8));
  }

  // draw main: thread bands + tasks or density sparkline when collapsed
  function drawMain() {
    const vp = container.getBoundingClientRect();
    const vpW = vp.width, vpH = vp.height;
    mainCtx.clearRect(0,0,vpW,vpH);

    mainCtx.save();
    mainCtx.translate(panX, panY);
    mainCtx.scale(scale, scale);

    const leftContentX = Math.max(0, (-panX) / scale);
    const rightContentX = Math.min(CONFIG.width_px, (vpW - panX) / scale);
    const topContentY = Math.max(0, (-panY) / scale);
    const bottomContentY = Math.min(1e9, (vpH - panY) / scale);

    let row_index_global = 0;
    for (let threadIdx = 0; threadIdx < threadLayouts.length; ++threadIdx) {
      const tl = threadLayouts[threadIdx];
      const thHeader = threadHeaders[threadIdx];
      const rowsCount = tl.rowsCount;
      const headerY = thHeader.headerY;
      const headerH = thHeader.headerH;
      // alternating background for header
      const bgColor = thHeader.altIndex === 0 ? CONFIG.ALTERNATING_BG_B : CONFIG.ALTERNATING_BG_A;
      mainCtx.fillStyle = bgColor;
      mainCtx.fillRect(0, headerY, CONFIG.width_px, headerH);

      // draw header text and collapse marker
      mainCtx.fillStyle = '#111';
      mainCtx.font = '13px Arial';
      mainCtx.textBaseline = 'middle';
      mainCtx.fillText((threadVisible.get(tl.id) ? '▼ ' : '▶ ') + tl.id, 6, headerY + headerH/2);

      if (!threadVisible.get(tl.id)) {
        // collapsed: draw density sparkline inside header region
        const bins = thHeader.densityBins || [];
        const binCount = thHeader.binCount || 1;
        if (bins && binCount > 0) {
          // normalize and draw sparkline centered in header
          let maxC = 1;
          for (let b=0;b<binCount;b++) if (bins[b] > maxC) maxC = bins[b];
          const sparkTop = headerY + 4;
          const sparkBottom = headerY + headerH - 4;
          mainCtx.beginPath();
          mainCtx.moveTo(0, sparkBottom);
          for (let b=0;b<binCount;b++) {
            const x = (b / binCount) * CONFIG.width_px;
            const hRel = (bins[b] / maxC) || 0;
            const y = sparkBottom - hRel * (sparkBottom - sparkTop);
            mainCtx.lineTo(x, y);
          }
          mainCtx.lineTo(CONFIG.width_px, sparkBottom);
          mainCtx.closePath();
          mainCtx.fillStyle = 'rgba(50,120,200,0.22)';
          mainCtx.fill();
          mainCtx.strokeStyle = 'rgba(50,120,200,0.6)';
          mainCtx.stroke();
        }
      } else {
        // expanded: draw rows and tasks
        for (let r = 0; r < rowsCount; ++r) {
          const rowIndex = row_index_global + r;
          const rowArr = rows[rowIndex];
          if (!rowArr || rowArr.length === 0) continue;
          let lo = 0, hi = rowArr.length - 1, startIndex = rowArr.length;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (rowArr[mid].x + rowArr[mid].w >= leftContentX) { startIndex = mid; hi = mid - 1; }
            else lo = mid + 1;
          }
          for (let i = startIndex; i < rowArr.length; ++i) {
            const t = rowArr[i];
            if (t.x > rightContentX) break;
            mainCtx.fillStyle = t.color;
            mainCtx.fillRect(t.x, t.y, t.w, t.h);
            // overheads inside parent
            if (Array.isArray(t.overheads)) {
              for (const oh of t.overheads) {
                mainCtx.fillStyle = CONFIG.OVERHEAD_COLOR;
                mainCtx.fillRect(t.x + t.w, t.y, oh.end - oh.start, t.h);
                
              }
            }
            // draw label if fits
            const padLeft = 4;
            const availableContentPx = Math.max(0, t.w - padLeft - 4);
            const screenAvailablePx = availableContentPx * scale;
            if (screenAvailablePx >= 10 && t.args) {
              const avgCharPx = 7;
              const estChars = Math.floor(screenAvailablePx / avgCharPx);
              let disp = t.args;
              if (t.args.length > estChars) {
                measureCtx.font = `${CONFIG.TASK_TEXT_SIZE}px Arial`;
                let loC=0, hiC=Math.min(t.args.length, estChars+50), best=0;
                while (loC<=hiC) {
                  const mid = (loC+hiC)>>1;
                  const sub = t.args.slice(0,mid);
                  const w = measureCtx.measureText(sub).width * scale;
                  if (w <= screenAvailablePx) { best = mid; loC = mid+1; } else hiC = mid-1;
                }
                if (best <= 0) disp = '…';
                else if (best < t.args.length) disp = t.args.slice(0, Math.max(0, best-1)) + '…';
                else disp = t.args;
              }
              mainCtx.fillStyle = '#111';
              mainCtx.font = `${CONFIG.TASK_TEXT_SIZE}px Arial`;
              mainCtx.textBaseline = 'middle';
              mainCtx.fillText(disp, t.x + padLeft, t.y + t.h * 0.5);
            }
          }
        }
      }
      row_index_global += rowsCount;
    }

    mainCtx.restore();
  }

  // minimap: overview-only; draw tasks simplified; draw visible rect; draw small header markers
  function drawMinimap() {
    miniCtx.clearRect(0,0,MINIMAP_W,MINIMAP_H);
    miniCtx.fillStyle = '#fff';
    miniCtx.fillRect(0,0,MINIMAP_W,MINIMAP_H);
    if (!rows || rows.length === 0) return;
    const rowsTotal = rowCount || 1;
    const rowH = Math.max(1, MINIMAP_H / rowsTotal);
    for (let r=0;r<rows.length;r++){
      const rowArr = rows[r];
      if (!rowArr) continue;
      const y = r * rowH;
      for (const t of rowArr) {
        const miniX = (t.x / CONFIG.width_px) * MINIMAP_W;
        const miniW = Math.max(1, (t.w / CONFIG.width_px) * MINIMAP_W);
        miniCtx.fillStyle = t.color;
        miniCtx.fillRect(miniX, y, miniW, Math.max(1, rowH - 1));
      }
    }
    // visible rect
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const leftContentX = Math.max(0, (-panX) / scale);
    const rightContentX = Math.min(CONFIG.width_px, (vpW - panX) / scale);
    const miniLeft = (leftContentX / CONFIG.width_px) * MINIMAP_W;
    const miniRight = (rightContentX / CONFIG.width_px) * MINIMAP_W;
    miniCtx.fillStyle = 'rgba(100,150,250,0.12)';
    miniCtx.fillRect(miniLeft, 0, Math.max(2, miniRight - miniLeft), MINIMAP_H);
    miniCtx.strokeStyle = 'rgba(100,150,250,0.28)';
    miniCtx.strokeRect(miniLeft+0.5, 0.5, Math.max(1, miniRight - miniLeft), MINIMAP_H - 1);

    // small header markers on right edge
    miniCtx.fillStyle = '#444';
    for (const th of threadHeaders) {
      const y = Math.max(0, Math.min(MINIMAP_H - 2, th.miniY - 2));
      miniCtx.fillRect(MINIMAP_W - 6, y, 4, 4);
    }
  }

  // render scheduling
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      drawRuler();
      drawMain();
      drawMinimap();
    });
  }

  // drawRuler (same)
  function drawRuler() {
    const rect = container.getBoundingClientRect();
    const w = rect.width; const h = CONFIG.header_h;
    rulerCtx.clearRect(0,0,w,h);
    rulerCtx.fillStyle = '#fff';
    rulerCtx.fillRect(0,0,w,h);
    const ticks = 8;
    rulerCtx.fillStyle = '#666';
    rulerCtx.textBaseline = 'middle';
    rulerCtx.font = '11px Arial';
    for (let i=0;i<=ticks;i++){
      const t_us = global_start + (global_end - global_start) * i / ticks;
      const xContent = timeToX(t_us);
      const x = xContent * scale + panX;
      rulerCtx.beginPath();
      rulerCtx.moveTo(x, h-1);
      rulerCtx.lineTo(x, 6);
      rulerCtx.strokeStyle = '#eee';
      rulerCtx.stroke();
      rulerCtx.fillStyle = '#666';
      rulerCtx.fillText(Math.round(t_us) + ' μs', x+3, h-10);
    }
    const vp = container.getBoundingClientRect();
    const leftContentX = Math.max(0, (-panX) / scale);
    const rightContentX = Math.min(CONFIG.width_px, (vp.width - panX) / scale);
    const contentToScreen = (cx) => cx * scale + panX;
    const pxLeft = contentToScreen(leftContentX);
    const pxRight = contentToScreen(rightContentX);
    rulerCtx.fillStyle = 'rgba(100,150,250,0.12)';
    rulerCtx.fillRect(pxLeft, 2, Math.max(1, pxRight - pxLeft), Math.max(4, h-8));
  }

  // interactivity: pan (mouse), touch (pinch), wheel zoom
  let dragging = false, lastX=0, lastY=0;
  mainCanvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true; lastX = ev.clientX; lastY = ev.clientY;
    mainCanvas.style.cursor = 'grabbing'; ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    panX += dx; panY += dy;
    lastX = ev.clientX; lastY = ev.clientY;
    updatePanLimits(); scheduleRender();
  });
  window.addEventListener('mouseup', ()=> { dragging=false; mainCanvas.style.cursor='default'; });

  // touch pinch & pan
  let touchState = { isPinching:false, lastDistance:null, lastCenter:null, isPanning:false };
  function pointerDistance(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }
  function midpoint(a,b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }

  mainCanvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    const t = ev.touches;
    if (t.length === 1) {
      touchState.isPanning = true; touchState.isPinching = false;
      touchState.lastCenter = { x: t[0].clientX, y: t[0].clientY };
    } else if (t.length >=2) {
      touchState.isPinching = true; touchState.isPanning = false;
      const a = {x:t[0].clientX,y:t[0].clientY}, b={x:t[1].clientX,y:t[1].clientY};
      touchState.lastDistance = pointerDistance(a,b); touchState.lastCenter = midpoint(a,b);
    }
  }, { passive:false });

  mainCanvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    const t = ev.touches;
    if (t.length === 1 && touchState.isPanning) {
      const cur = { x: t[0].clientX, y: t[0].clientY };
      const dx = cur.x - touchState.lastCenter.x, dy = cur.y - touchState.lastCenter.y;
      panX += dx; panY += dy; touchState.lastCenter = cur; updatePanLimits(); scheduleRender();
    } else if (t.length >=2) {
      const a = {x:t[0].clientX,y:t[0].clientY}, b={x:t[1].clientX,y:t[1].clientY};
      const dist = pointerDistance(a,b); const center = midpoint(a,b);
      if (touchState.lastDistance) {
        const factor = dist / touchState.lastDistance;
        const rect = container.getBoundingClientRect();
        zoomAt(factor, center.x - rect.left, center.y - rect.top);
      }
      touchState.lastDistance = dist; touchState.lastCenter = center;
    }
  }, { passive:false });

  mainCanvas.addEventListener('touchend', (ev) => {
    ev.preventDefault();
    touchState.isPinching=false; touchState.isPanning=false; touchState.lastDistance=null; touchState.lastCenter=null;
  }, { passive:false });

  // wheel zoom
  mainCanvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = container.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const factor = ev.deltaY > 0 ? 1/1.12 : 1.12;
    zoomAt(factor, cx, ev.clientY - rect.top);
  }, { passive:false });

  function zoomAt(factor, clientX, clientY) {
    const newScale = Math.max(0.05, Math.min(20, scale * factor));
    const contentX = (clientX - panX) / scale;
    const contentY = (clientY - panY) / scale;
    panX = clientX - contentX * newScale;
    panY = clientY - contentY * newScale;
    scale = newScale;
    if (zoomSlider) { zoomSlider.value = scale; zoomValue.textContent = scale.toFixed(2) + '×'; }
    updatePanLimits(); scheduleRender();
  }

  zoomSlider.addEventListener('input', (ev) => {
    const newScale = parseFloat(ev.target.value);
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const factor = newScale / scale;
    zoomAt(factor, cx, cy);
  });

  btnZoomIn.addEventListener('click', ()=> { const r = container.getBoundingClientRect(); zoomAt(1.2, r.width/2, r.height/2); });
  btnZoomOut.addEventListener('click', ()=> { const r = container.getBoundingClientRect(); zoomAt(1/1.2, r.width/2, r.height/2); });
  btnReset.addEventListener('click', ()=> { scale=1; panX=0; panY=0; updatePanLimits(); scheduleRender(); });

  panXSlider.addEventListener('input', (ev) => { panX = parseFloat(ev.target.value); updatePanLimits(); scheduleRender(); });
  btnFit.addEventListener('click', () => { fitToWidth(); scheduleRender(); });

  function fitToWidth() {
    const rect = container.getBoundingClientRect();
    const vpW = rect.width;
    const scaleX = vpW / CONFIG.width_px;
    const newScale = Math.min(1.0, Math.max(0.05, scaleX));
    scale = newScale; panX=0; panY=0; updatePanLimits();
  }

  btnCollapseAll.addEventListener('click', () => {
    for (const k of threadVisible.keys()) threadVisible.set(k, false);
    scheduleRender();
  });
  btnExpandAll.addEventListener('click', () => {
    for (const k of threadVisible.keys()) threadVisible.set(k, true);
    scheduleRender();
  });

  // minimap: drag-to-move + click-to-center (overview-only)
  minimapCanvas.style.touchAction = 'none';
  let miniIsPointerDown = false;
  let miniPointerId = null;
  let miniPointerStart = null;
  let miniElementStart = null;
  const MINI_DRAG_THRESHOLD = 6;

  function getMinimapComputedPos() {
    const cs = getComputedStyle(minimapCanvas);
    let left = cs.left, top = cs.top;
    if (!left || left === 'auto') left = minimapCanvas.offsetLeft + 'px';
    if (!top  || top === 'auto')  top  = minimapCanvas.offsetTop + 'px';
    return { left: parseFloat(left), top: parseFloat(top) };
  }

  minimapCanvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    minimapCanvas.setPointerCapture && minimapCanvas.setPointerCapture(ev.pointerId);
    miniIsPointerDown = true; miniPointerId = ev.pointerId;
    miniPointerStart = { x: ev.clientX, y: ev.clientY };
    const pos = getMinimapComputedPos();
    miniElementStart = { left: pos.left, top: pos.top, isDragActive: false };
  });

  minimapCanvas.addEventListener('pointermove', (ev) => {
    if (!miniIsPointerDown || ev.pointerId !== miniPointerId) return;
    ev.preventDefault();
    const dx = ev.clientX - miniPointerStart.x;
    const dy = ev.clientY - miniPointerStart.y;
    const distSq = dx*dx + dy*dy;
    if (!miniElementStart.isDragActive && distSq >= MINI_DRAG_THRESHOLD*MINI_DRAG_THRESHOLD) {
      miniElementStart.isDragActive = true;
      minimapCanvas.style.cursor = 'grabbing';
    }
    if (miniElementStart.isDragActive) {
      const newLeft = miniElementStart.left + dx;
      const newTop = miniElementStart.top + dy;
      minimapCanvas.style.left = `${newLeft}px`;
      minimapCanvas.style.top = `${newTop}px`;
      minimapCanvas.style.right = '';
      minimapCanvas.style.bottom = '';
    }
  });

  minimapCanvas.addEventListener('pointerup', (ev) => {
    if (!miniIsPointerDown || ev.pointerId !== miniPointerId) return;
    ev.preventDefault();
    minimapCanvas.releasePointerCapture && minimapCanvas.releasePointerCapture(ev.pointerId);
    if (miniElementStart.isDragActive) {
      miniElementStart.isDragActive = false;
      miniIsPointerDown = false; miniPointerId=null; miniPointerStart=null; miniElementStart=null;
      minimapCanvas.style.cursor = 'pointer';
      scheduleRender(); return;
    }
    // treat as click/tap: center main view
    const rect = minimapCanvas.getBoundingClientRect();
    const cx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    const contentX = (cx / rect.width) * CONFIG.width_px;
    const vpRect = container.getBoundingClientRect();
    const centerScreenX = vpRect.width / 2;
    panX = centerScreenX - contentX * scale;
    updatePanLimits(); scheduleRender();

    miniIsPointerDown = false; miniPointerId=null; miniPointerStart=null; miniElementStart=null;
  });

  minimapCanvas.addEventListener('pointercancel', (ev) => {
    miniIsPointerDown = false; miniPointerId=null; miniPointerStart=null; miniElementStart=null;
    minimapCanvas.style.cursor = 'pointer';
  });

  // tooltip (hit test) on main canvas
  mainCanvas.addEventListener('mousemove', (ev) => {
    if (dragging) return;
    const rect = container.getBoundingClientRect();
    const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
    const contentX = (cx - panX) / scale;
    const contentY = (cy - panY) / scale;
    const singleRowPitch = CONFIG.row_height + CONFIG.row_padding;
    const r = Math.floor((contentY - CONFIG.header_h) / singleRowPitch);
    if (r < 0 || r >= rows.length) { tooltip.style.display='none'; return; }
    const rowArr = rows[r];
    if (!rowArr || rowArr.length === 0) { tooltip.style.display='none'; return; }
    let lo=0, hi=rowArr.length-1, found=null;
    while (lo<=hi) {
      const mid=(lo+hi)>>1; const t=rowArr[mid];
      if (t.x <= contentX && t.x + t.w >= contentX) { found=t; break; }
      if (t.x + t.w < contentX) lo = mid+1; else hi = mid-1;
    }
    if (found && threadVisible.get(found.thread)) {
      tooltip.style.display='block';
      tooltip.style.left = (ev.clientX + 12) + 'px';
      tooltip.style.top = (ev.clientY + 12) + 'px';
      tooltip.textContent = `${found.args}\n${found.start} - ${found.end} μs\nthread: ${found.thread}`;
    } else tooltip.style.display='none';
  });
  mainCanvas.addEventListener('mouseleave', ()=> { tooltip.style.display='none'; });

  // clicking header toggles collapse/expand
  mainCanvas.addEventListener('click', (ev) => {
    const rect = container.getBoundingClientRect();
    const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
    const contentY = (cy - panY) / scale;
    let row_index_global = 0;
    for (let threadIdx = 0; threadIdx < threadLayouts.length; ++threadIdx) {
      const tl = threadLayouts[threadIdx];
      const headerY = CONFIG.header_h + row_index_global * (CONFIG.row_height + CONFIG.row_padding) + threadIdx * CONFIG.track_spacing;
      const headerH = CONFIG.row_height + CONFIG.row_padding;
      if (contentY >= headerY && contentY <= headerY + headerH) {
        const prev = threadVisible.get(tl.id);
        threadVisible.set(tl.id, !prev);
        scheduleRender();
        break;
      }
      row_index_global += tl.rowsCount;
    }
  });

  // file loading
  async function loadTraceFromURL(url='trace.json') {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      processTrace(data);
    } catch (e) { console.error('Failed to load trace.json:', e); }
  }

  fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        processTrace(json);
      } catch (err) { alert('Не удалось распарсить файл: ' + err); }
    };
    reader.readAsText(f);
  });

  function processTrace(traceJson) {
    if (!worker) createWorker();
    if (!worker) { console.error('Worker unavailable'); return; }
    // compute global start/end if missing
    try {
      if (!traceJson.global_start) {
        let minStart = Infinity, maxEnd = -Infinity;
        for (const th of (traceJson.threads || [])) {
          for (const t of (th.tasks || [])) {
            if (t.start < minStart) minStart = t.start;
            if (t.end > maxEnd) maxEnd = t.end;
          }
        }
        traceJson.global_start = (minStart === Infinity) ? 0 : minStart;
        traceJson.global_end = (maxEnd === -Infinity) ? traceJson.global_start + 1 : maxEnd;
      }
      global_start = traceJson.global_start;
      global_end = traceJson.global_end;
    } catch (e) {
      console.warn('Failed compute global range', e);
    }
    const cfg = {
      width_px: CONFIG.width_px,
      left_margin: CONFIG.left_margin,
      header_h: CONFIG.header_h,
      row_height: CONFIG.row_height,
      row_padding: CONFIG.row_padding,
      track_spacing: CONFIG.track_spacing,
      global_start, global_end,
      binCount: 512
    };
    worker.postMessage({ cmd: 'process', data: traceJson, config: cfg });
  }

  // init
  function init() {
    createWorker();
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);
    // try auto-load
    loadTraceFromURL('trace.json');
  }
  init();

  // helpers exposed
  window.__timeline = { scheduleRender, processTrace };

})();
