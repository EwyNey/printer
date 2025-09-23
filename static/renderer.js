// renderer.js
// Обновлённый рендерер timeline с измерением текста через getComputedTextLength() и миникартой
// - Зависит от static/trace.json (fetch)
// - Сохраняет: groups, collapse/expand, zoom/pan, panX slider, ruler
// - Новое: точное измерение текста и minimap

(async function(){
  // ----------------- UI references -----------------
  const container = document.getElementById('svg-container');
  const tooltip = document.getElementById('tooltip');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomValue = document.getElementById('zoomValue');
  const panXSlider = document.getElementById('panXSlider');
  const panXValue = document.getElementById('panXValue');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnReset = document.getElementById('btnReset');
  const btnCollapseAll = document.getElementById('btnCollapseAll');
  const btnExpandAll = document.getElementById('btnExpandAll');

  const btnFit = document.getElementById('btnFit');
  // ...
  if (btnFit) btnFit.addEventListener('click', () => {
    // compute scale that fits whole content in viewport
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const vpH = vp.height;
    // because svg uses viewBox width_px x contentHeight, scale is in terms of pixels
    const scaleX = vpW / contentWidth;
    const scaleY = vpH / contentHeight;
    // choose smaller so that all content fits (but prevent too-large downscaling)
    let newScale = Math.max(0.0001, Math.min(20, Math.min(scaleX, scaleY)));
    // set pan so content is centered
    // compute svg center in svg-coords
    const svgCTM = svg.getScreenCTM();
    // simpler: set panX so left maps to left edge
    panX = 0; panY = 0;
    // but better: center content inside viewport: desired panX = (vpW - contentWidth*newScale) / 2
    // convert that to SVG coords: since viewBox maps 0..contentWidth to svg width, we can set panX to that value
    // Because we use translate(panX panY) scale(scale) in content coordinates, we set panX = (vpW_in_svg - contentWidth*newScale)/2
    // However with responsive SVG + viewBox, easier: compute panX so that content is centered in viewport:
    panX = ( (vpW / (vpW / (width_px))) - contentWidth * newScale) / 2; // fallback if complex
    // Simpler & robust approach: reset to top-left so full content visible:
    panX = 0;
    panY = 0;
    scale = newScale;
    updatePanLimits();
    applyTransform();
  });



  // ----------------- Load JSON -----------------
  let data;
  try {
    const resp = await fetch('trace.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    container.innerText = 'Не удалось загрузить trace.json: ' + String(e);
    return;
  }

  // ----------------- Layout params -----------------
  const width_px = 1400;
  const left_margin = 200;
  const row_height = 20;
  const row_padding = 6;
  const header_h = 40;
  const track_spacing = 12;

  const threads = data.threads || [];
  const global_start = data.global_start;
  const global_end = data.global_end || (global_start + 1);

  // ----------------- Color / utils -----------------
  function colorFromInt(x){
    x = Number(x) >>> 0;
    const h = (x * 2654435761) >>> 0;
    const hue = h % 360;
    const sat = 60 + ((h >> 8) % 20);
    const light = 45 + ((h >> 16) % 10);
    return `hsl(${hue} ${sat}% ${light}%)`;
  }
  function colorFromString(s){
    let h = 1469598103934665603n;
    for (let i=0;i<s.length;i++){
      h ^= BigInt(s.charCodeAt(i));
      h = (h * 1099511628211n) & ((1n<<64n)-1n);
    }
    const x = Number(h & 0xFFFFFFFFn);
    return colorFromInt(x);
  }
  function escapeXml(s){
    return String(s).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'})[c]);
  }

  // ----------------- Rows assignment -----------------
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

  // ----------------- Prepare thread layouts -----------------
  const threadLayouts = [];
  let total_rows = 0;
  for (const th of threads) {
    const {assigned, rowsCount} = assignRows(th.tasks || []);
    threadLayouts.push({id: th.id, assigned, rowsCount});
    total_rows += rowsCount;
  }

  const contentHeight = Math.round(header_h + total_rows * (row_height + row_padding) + threadLayouts.length * track_spacing + 100);
  const contentWidth = width_px;

  // ----------------- Time <-> X -----------------
  function timeToX(t_us) {
    const usable = (width_px - left_margin - 40);
    const rel = (t_us - global_start) / (global_end - global_start);
    return left_margin + rel * usable;
  }
  function xToTime(x) {
    const usable = (width_px - left_margin - 40);
    const rel = (x - left_margin) / usable;
    return global_start + rel * (global_end - global_start);
  }
  function timeToX_clamped(t_us) {
    return timeToX(Math.max(global_start, Math.min(global_end, t_us)));
  }

  // ----------------- Create main SVG -----------------
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, 'svg');
  // keep internal coordinate system width_px x contentHeight, but render responsive
  svg.setAttribute('width', '100%');                    // takes container width
  svg.setAttribute('height', '100%');            // height in CSS pixels
  svg.setAttribute('viewBox', `0 0 ${width_px} ${contentHeight}`); // preserve coordinate system
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.setAttribute('id','timeline-svg');

  svg.style.touchAction = 'none';
  container.appendChild(svg);

  // ----------------- Ruler (outside content) -----------------
  const ruler = document.createElementNS(svgNS, 'g');
  ruler.setAttribute('id','ruler');
  svg.appendChild(ruler);
  const TICKS = 8;
  for (let i=0;i<=TICKS;i++){
    const t_us = global_start + (global_end - global_start) * i / TICKS;
    const x = timeToX(t_us);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', 2); line.setAttribute('y2', header_h - 6);
    line.setAttribute('stroke', '#eee');
    ruler.appendChild(line);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', x + 3); text.setAttribute('y', header_h - 10);
    text.setAttribute('class', 'time-label');
    text.textContent = Math.round(t_us) + ' μs';
    ruler.appendChild(text);
  }
  const visibleRect = document.createElementNS(svgNS,'rect');
  visibleRect.setAttribute('id','visibleRangeRect');
  visibleRect.setAttribute('y', 2);
  visibleRect.setAttribute('height', Math.max(8, header_h - 8));
  visibleRect.setAttribute('fill', 'rgba(100,150,250,0.12)');
  visibleRect.setAttribute('stroke', 'rgba(100,150,250,0.25)');
  svg.appendChild(visibleRect);
  const visibleStartText = document.createElementNS(svgNS,'text');
  visibleStartText.setAttribute('id','visibleStartText');
  visibleStartText.setAttribute('y', header_h - 22);
  visibleStartText.setAttribute('class','time-label');
  svg.appendChild(visibleStartText);
  const visibleEndText = document.createElementNS(svgNS,'text');
  visibleEndText.setAttribute('id','visibleEndText');
  visibleEndText.setAttribute('y', header_h - 22);
  visibleEndText.setAttribute('class','time-label');
  svg.appendChild(visibleEndText);

  // ----------------- Content group (transformable) -----------------
  const content = document.createElementNS(svgNS, 'g');
  content.setAttribute('id','content');
  svg.appendChild(content);

  // ----------------- Draw threads & tasks (groups) -----------------
  (function drawContent(){
    let row_index_global = 0;
    for (let threadIdx = 0; threadIdx < threadLayouts.length; ++threadIdx) {
      const thLayout = threadLayouts[threadIdx];
      const th = thLayout.id;
      const assigned = thLayout.assigned;
      const rowsCount = thLayout.rowsCount;

      const headerY = header_h + row_index_global * (row_height + row_padding) + threadIdx * track_spacing;
      const headerH = row_height + row_padding;

      const threadGroup = document.createElementNS(svgNS, 'g');
      threadGroup.setAttribute('class', 'thread-block');
      threadGroup.dataset.thread = th;
      content.appendChild(threadGroup);

      const hr = document.createElementNS(svgNS, 'rect');
      hr.setAttribute('x', 0);
      hr.setAttribute('y', headerY);
      hr.setAttribute('width', width_px);
      hr.setAttribute('height', headerH);
      hr.setAttribute('fill', '#f8f8f8');
      threadGroup.appendChild(hr);

      const htxt = document.createElementNS(svgNS, 'text');
      htxt.setAttribute('x', 8);
      htxt.setAttribute('y', headerY + headerH/1.8);
      htxt.setAttribute('class', 'thread-label');
      htxt.textContent = '▶ ' + th;
      htxt.style.cursor = 'pointer';
      // mark class for selection
      htxt.classList.add('thread-label');
      threadGroup.appendChild(htxt);

      for (const pair of assigned) {
        const t = pair.task;
        const r = pair.row;
        const x = timeToX(t.start);
        const w = Math.max(2, timeToX(t.end) - x);
        const y = header_h + (row_index_global + r) * (row_height + row_padding) + threadIdx * track_spacing;

        const taskGroup = document.createElementNS(svgNS, 'g');
        taskGroup.setAttribute('class', 'task-group');
        taskGroup.dataset.thread = th;
        taskGroup.dataset.row = String(row_index_global + r);
        content.appendChild(taskGroup);

        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', x); rect.setAttribute('y', y);
        rect.setAttribute('width', w); rect.setAttribute('height', row_height);
        const fill = (t.color !== null && t.color !== undefined) ? colorFromInt(t.color) : colorFromString(t.args || "");
        rect.setAttribute('fill', fill);
        rect.classList.add('task', 'task-rect');
        rect.dataset.args = t.args;
        rect.dataset.start = t.start;
        rect.dataset.end = t.end;
        rect.dataset.thread = th;
        taskGroup.appendChild(rect);

        // label: store full & available (content coords)
        const pad_left = 4;
        const pad_right = 4;
        const available_px = Math.max(0, w - pad_left - pad_right);
        const raw_label = (t.args || "").replace(/\n/g, " ").trim();
        if (available_px >= 6 && raw_label.length > 0) {
          // initial rough crop by average char to avoid extremely long insertion cost
          const avg_char_px_est = 7.0;
          const max_chars_initial = Math.max(1, Math.floor(available_px / avg_char_px_est));
          let disp = raw_label.length > max_chars_initial ? (max_chars_initial <= 1 ? '…' : escapeXml(raw_label.slice(0, max_chars_initial-1)) + '…') : escapeXml(raw_label);

          const text = document.createElementNS(svgNS, 'text');
          text.setAttribute('x', x + pad_left);
          text.setAttribute('y', y + row_height * 0.7);
          text.setAttribute('class', 'task-label');
          text.textContent = disp;
          text.dataset.full = raw_label;
          text.dataset.available = String(available_px); // content units
          taskGroup.appendChild(text);
        }
      }

      row_index_global += rowsCount;
    }
  })();

  // ----------------- Text measurement helpers (getComputedTextLength) -----------------
  // Cache full-text unscaled widths to reuse
  const textWidthCache = new Map();
  // temporary element used for measurement (we add it to svg but keep hidden)
  const tempText = document.createElementNS(svgNS, 'text');
  tempText.setAttribute('class','task-label');
  tempText.setAttribute('style', 'visibility:hidden; position: absolute;'); // hidden, but measurable
  svg.appendChild(tempText);

  function measureUnscaledTextWidth(str) {
    if (!str) return 0;
    const key = String(str);
    if (textWidthCache.has(key)) return textWidthCache.get(key);
    tempText.textContent = str;
    // getComputedTextLength returns CSS px at the current font-size (untransformed)
    const w = tempText.getComputedTextLength();
    textWidthCache.set(key, w);
    return w;
  }

  // measure substring width quickly (unscaled)
  function measureUnscaledSubstringWidth(s, len) {
    // measure substring s.slice(0,len)
    const sub = s.slice(0, len);
    return measureUnscaledTextWidth(sub);
  }

  // get maximum chars that can fit given available screen px and scale (uses measurement)
  function computeMaxCharsForScreenWidth(fullStr, available_screen_px, scale) {
    if (!fullStr) return 0;
    // measure full unscaled width
    const fullWidth = measureUnscaledTextWidth(fullStr); // unscaled CSS px
    const screenFullWidth = fullWidth * scale;
    if (screenFullWidth <= available_screen_px) return fullStr.length;
    // estimate average char width (unscaled)
    const avgUnscaled = fullWidth / Math.max(1, fullStr.length);
    const avgScreen = avgUnscaled * scale;
    let guess = Math.floor(available_screen_px / avgScreen);
    // clamp
    guess = Math.max(0, Math.min(fullStr.length, guess));
    // refine by measuring substring widths (binary expansion)
    // ensure guess fits; if guess too big reduce
    while (guess > 0) {
      const w = measureUnscaledSubstringWidth(fullStr, guess) * scale;
      if (w <= available_screen_px) break;
      guess = Math.max(0, Math.floor(guess * 0.9));
      if (guess === 0) break;
    }
    // try to increase a little if there's spare space
    while (guess < fullStr.length) {
      const wNext = measureUnscaledSubstringWidth(fullStr, guess+1) * scale;
      if (wNext <= available_screen_px) guess++;
      else break;
    }
    return guess;
  }

  // ----------------- Minimap config & build -----------------
  const MINIMAP_WIDTH = 420;    // increased size per request
  const MINIMAP_HEIGHT = 120;
  const MINIMAP_PADDING = 6;
  // create minimap container (SVG) and its group
  const minimap = document.createElementNS(svgNS, 'svg');
  minimap.setAttribute('width', MINIMAP_WIDTH + 2*MINIMAP_PADDING);
  minimap.setAttribute('height', MINIMAP_HEIGHT + 2*MINIMAP_PADDING);
  minimap.setAttribute('id','minimap');
  minimap.style.position = 'absolute';
  minimap.style.bottom = '67px';
  minimap.style.right = '12px';
  minimap.style.top = '';
  minimap.style.left = '';
  minimap.style.border = '1px solid rgba(0,0,0,0.12)';
  minimap.style.background = 'white';
  // place it on top of container
  container.style.position = 'relative';
  container.appendChild(minimap);

  const miniGroup = document.createElementNS(svgNS, 'g');
  miniGroup.setAttribute('transform', `translate(${MINIMAP_PADDING},${MINIMAP_PADDING})`);
  minimap.appendChild(miniGroup);

  // draw minimap base (background)
  const miniBg = document.createElementNS(svgNS,'rect');
  miniBg.setAttribute('x', 0);
  miniBg.setAttribute('y', 0);
  miniBg.setAttribute('width', MINIMAP_WIDTH);
  miniBg.setAttribute('height', MINIMAP_HEIGHT);
  miniBg.setAttribute('fill', '#fafafa');
  miniBg.setAttribute('stroke', '#eee');
  miniGroup.appendChild(miniBg);

  // scale from content X to minimap X:
  function xToMiniX(x) {
    const rel = x / contentWidth;
    return rel * MINIMAP_WIDTH;
  }
  function timeToMiniX(t_us) {
    const x = timeToX(t_us);
    return xToMiniX(x);
  }

  // container for simplified task rectangles
  const miniTasksGroup = document.createElementNS(svgNS, 'g');
  miniGroup.appendChild(miniTasksGroup);

  // visible rect overlay on minimap
  const miniVisible = document.createElementNS(svgNS, 'rect');
  miniVisible.setAttribute('fill', 'rgba(100,150,250,0.18)');
  miniVisible.setAttribute('stroke', 'rgba(100,150,250,0.28)');
  miniGroup.appendChild(miniVisible);

  // draw simplified overview: we map tasks to small bars by time only (stacked)
  function drawMinimapOverview(){
    // clear children
    while (miniTasksGroup.firstChild) miniTasksGroup.removeChild(miniTasksGroup.firstChild);
    // small height per row
    const rowsTotal = total_rows || 1;
    const rowH = Math.max(2, Math.floor((MINIMAP_HEIGHT - 4) / Math.max(1, rowsTotal)));
    // for performance, draw each task rect simple
    let drawnCount = 0;
    // iterate threadLayouts and their assigned tasks in the same order used above
    let rowIndex = 0;
    for (let ti=0; ti<threadLayouts.length; ++ti) {
      const tl = threadLayouts[ti];
      const assigned = tl.assigned;
      for (const pair of assigned) {
        const t = pair.task;
        const y = Math.floor(rowIndex * rowH);
        const miniX = xToMiniX(timeToX(t.start));
        const miniW = Math.max(1, xToMiniX(timeToX(t.end)) - miniX);
        const r = document.createElementNS(svgNS,'rect');
        r.setAttribute('x', miniX);
        r.setAttribute('y', y);
        r.setAttribute('width', miniW);
        r.setAttribute('height', Math.max(1,rowH-1));
        r.setAttribute('fill', (t.color!==null && t.color!==undefined) ? colorFromInt(t.color) : colorFromString(t.args || ""));
        miniTasksGroup.appendChild(r);
        drawnCount++;
        rowIndex++;
      }
    }
  }

  // minimap interaction: click to center view, drag to pan
  let miniDragging = false;
  let miniDragStartX = 0;
  function updateMiniVisible() {
    // visible content bounds in content coords
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const x_left_content = (-panX) / scale;
    const x_right_content = (vpW - panX) / scale;
    const xL = Math.max(0, x_left_content);
    const xR = Math.min(contentWidth, x_right_content);
    const miniX = xToMiniX(xL);
    const miniW = Math.max(2, xToMiniX(xR) - miniX);
    miniVisible.setAttribute('x', miniX);
    miniVisible.setAttribute('y', 0);
    miniVisible.setAttribute('width', miniW);
    miniVisible.setAttribute('height', MINIMAP_HEIGHT);
  }
  // click handler: center main view at clicked time
  minimap.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const rect = minimap.getBoundingClientRect();
    const cx = ev.clientX - rect.left - MINIMAP_PADDING;
    // clamp
    const clampedX = Math.max(0, Math.min(MINIMAP_WIDTH, cx));
    const contentX = (clampedX / MINIMAP_WIDTH) * contentWidth;
    // center main viewport at contentX
    const vp = container.getBoundingClientRect();
    const centerClientX = vp.left + vp.width/2;
    // we need to compute client coordinates corresponding to contentX
    // get screen point of contentX at y=0
    const point = svg.createSVGPoint();
    point.x = contentX; point.y = 0;
    // transform content-local to screen requires current transform: construct matrix
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    // we want contentX to be centered, so compute new panX:
    // screenX = ctm.a * (contentX * scale + panX) + ctm.e  ... complicated.
    // Simpler: compute desired panX so that contentX maps to centerClientX in SVG coords:
    // svgP = contentX * scale + panX  (since we use translate(panX panY) scale(scale) applied to content)
    // svg screen coordinate = svg.getScreenCTM().e + svgP * ctm.a ... Rather than messing with CTM, do simpler:
    // Set panX such that contentX goes to center of viewport in svg coords:
    const vpRect = container.getBoundingClientRect();
    // compute svg point for center of viewport
    const centerClient = {x: vpRect.left + vpRect.width/2, y: vpRect.top + vpRect.height/2};
    // convert center client to svg coordinates
    const pt = svg.createSVGPoint();
    pt.x = centerClient.x; pt.y = centerClient.y;
    const svgCTM = svg.getScreenCTM();
    if (!svgCTM) return;
    const svgCenter = pt.matrixTransform(svgCTM.inverse());
    // then panX = svgCenter.x - contentX * scale
    panX = svgCenter.x - contentX * scale;
    // clamp then apply
    updatePanLimits();
    applyTransform();
    updateMiniVisible();
    miniDragging = true;
    miniDragStartX = ev.clientX;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!miniDragging) return;
    // compute delta in minimap coords
    const d = ev.clientX - miniDragStartX;
    const dxContent = (d / MINIMAP_WIDTH) * contentWidth;
    // adjust panX so content shifts dxContent to right
    // new panX = old panX - dxContent * scale (because moving content right should shift panX negative)
    panX -= dxContent * scale;
    miniDragStartX = ev.clientX;
    updatePanLimits();
    applyTransform();
    updateMiniVisible();
  });
  window.addEventListener('mouseup', ()=> { miniDragging = false; });

  // ----------------- Pan/zoom state & limits -----------------
  let scale = 1.0, panX = 0, panY = 0;
  let panXMin = 0, panXMax = 0, panYMin = 0, panYMax = 0;

  function updatePanLimits(){
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const vpH = vp.height;
    const scaledW = contentWidth * scale;
    const scaledH = contentHeight * scale;

    if (scaledW > vpW) {
      panXMin = vpW - scaledW;
      panXMax = 0;
    } else {
      const center = Math.floor((vpW - scaledW) / 2);
      panXMin = panXMax = center;
    }
    if (scaledH > vpH) {
      panYMin = vpH - scaledH;
      panYMax = 0;
    } else {
      const centerY = Math.floor((vpH - scaledH) / 2);
      panYMin = panYMax = centerY;
    }

    if (panXSlider) {
      panXSlider.min = Math.round(panXMin);
      panXSlider.max = Math.round(panXMax);
      if (panX < panXMin) panX = panXMin;
      if (panX > panXMax) panX = panXMax;
      panXSlider.value = Math.round(panX);
      panXValue.textContent = `${Math.round(panX)} px`;
      panXSlider.disabled = (panXMin === panXMax);
    }
  }

  function clampPan(){
    if (panX < panXMin) panX = panXMin;
    if (panX > panXMax) panX = panXMax;
    if (panY < panYMin) panY = panYMin;
    if (panY > panYMax) panY = panYMax;
  }

  // ----------------- Labels update using measurements -----------------
  function updateLabels(){
    const texts = content.querySelectorAll('text.task-label, text[class~="task-label"]');
    texts.forEach(t => {
      const full = t.dataset.full || '';
      const available_content_px = parseFloat(t.dataset.available || '0');
      const screen_available_px = available_content_px * scale;
      if (!full || screen_available_px < 4) {
        t.textContent = '';
        t.style.display = 'none';
        return;
      }
      // compute how many chars fit using getComputedTextLength heuristic + substring check
      const maxChars = computeMaxCharsForScreenWidth(full, screen_available_px, 1 /* scale already applied below differently */);
      // Note: computeMaxCharsForScreenWidth expects multiplied by scale on measurement; but we measure unscaled widths and compare:
      // we'll implement correct call below:
      const chars = computeMaxCharsForScreenWidth(full, screen_available_px, 1); // here function multiplies by scale internally; we pass scale=1 to avoid double-scaling
      // However above function expects scale param; to keep consistent, call with scale=1 and we compare screen px directly using measureUnscaled... * scale.
      // The function already uses passed scale. So call correctly:
      const charsFit = computeMaxCharsForScreenWidth(full, screen_available_px, 1);
      if (charsFit <= 0) {
        t.textContent = '';
        t.style.display = 'none';
      } else if (charsFit < full.length) {
        t.textContent = full.slice(0, charsFit - 1) + '…';
        t.style.display = '';
      } else {
        t.textContent = full;
        t.style.display = '';
      }
    });

    // Note: computeMaxCharsForScreenWidth does measure unscaled widths and multiplies by scale internally.
    // For performance we kept it conservative; it caches measurements.
  }

  // ----------------- Ruler update -----------------
  function updateRuler(){
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const x_left_content = (-panX) / scale;
    const x_right_content = (vpW - panX) / scale;
    const contentMinX = 0;
    const contentMaxX = contentWidth;
    const xL = Math.max(contentMinX, x_left_content);
    const xR = Math.min(contentMaxX, x_right_content);
    const tL = xToTime(xL);
    const tR = xToTime(xR);
    const pxL = timeToX_clamped(Math.max(global_start, Math.min(global_end, tL)));
    const pxR = timeToX_clamped(Math.max(global_start, Math.min(global_end, tR)));
    if (pxR <= pxL) {
      visibleRect.setAttribute('x', pxL);
      visibleRect.setAttribute('width', 1);
    } else {
      visibleRect.setAttribute('x', pxL);
      visibleRect.setAttribute('width', Math.max(1, pxR - pxL));
    }
    visibleStartText.textContent = Math.round(tL) + ' μs';
    visibleEndText.textContent = Math.round(tR) + 'μs';
    visibleStartText.setAttribute('x', Math.max(left_margin+2, pxL));
    visibleEndText.setAttribute('x', Math.min(width_px - 60, pxR - 40));
  }

  // ----------------- apply transform -----------------
  function applyTransform(){
    clampPan();
    content.setAttribute('transform', `translate(${panX} ${panY}) scale(${scale})`);
    if (zoomSlider) zoomSlider.value = scale;
    if (zoomValue) zoomValue.textContent = scale.toFixed(2) + '×';
    if (panXSlider) {
      panXSlider.value = Math.round(panX);
      panXValue.textContent = `${Math.round(panX)} px`;
    }
    // update dependent UI
    updateLabels();
    updateRuler();
    updateMiniVisible();
  }

  // ----------------- Zoom helpers -----------------
  function zoomAt(factor, clientX, clientY){
    const newScale = Math.max(0.05, Math.min(20, scale * factor));
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());
    const contentX = (svgP.x - panX) / scale;
    const contentY = (svgP.y - panY) / scale;
    panX = svgP.x - contentX * newScale;
    panY = svgP.y - contentY * newScale;
    scale = newScale;
    updatePanLimits();
    applyTransform();
  }
  function zoomTo(newScale, clientX, clientY){
    if (newScale <= 0) return;
    zoomAt(newScale / scale, clientX, clientY);
  }

  // ----------------- UI bindings -----------------
  if (btnZoomIn) btnZoomIn.addEventListener('click', ()=>{
    const vp = svg.getBoundingClientRect();
    zoomAt(1.2, vp.width/2, vp.height/2);
  });
  if (btnZoomOut) btnZoomOut.addEventListener('click', ()=>{
    const vp = svg.getBoundingClientRect();
    zoomAt(1/1.2, vp.width/2, vp.height/2);
  });
  if (btnReset) btnReset.addEventListener('click', ()=>{
    scale = 1.0; panX = 0; panY = 0; updatePanLimits(); applyTransform();
  });
  if (zoomSlider) {
    zoomSlider.addEventListener('input', (ev)=>{
      const newScale = parseFloat(ev.target.value);
      const vp = svg.getBoundingClientRect();
      zoomTo(newScale, vp.width/2, vp.height/2);
    });
  }
  svg.addEventListener('wheel', function(ev){
    ev.preventDefault();
    const delta = ev.deltaY;
    const factor = delta > 0 ? 1/1.12 : 1.12;
    zoomAt(factor, ev.clientX, ev.clientY);
  }, {passive:false});

  // pan by dragging (X and Y)
  let dragging = false, lastX=0, lastY=0;
  svg.addEventListener('mousedown', function(ev){
    if (ev.button !== 0) return;
    dragging = true;
    lastX = ev.clientX; lastY = ev.clientY;
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(ev){
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    panX += dx; panY += dy;
    lastX = ev.clientX; lastY = ev.clientY;
    updatePanLimits();
    applyTransform();
  });
  window.addEventListener('mouseup', function(ev){
    if (dragging) {
      dragging = false;
      svg.style.cursor = 'default';
      updatePanLimits();
      applyTransform();
    }
  });

  if (panXSlider) {
    panXSlider.addEventListener('input', (ev) => {
      panX = parseFloat(ev.target.value);
      updatePanLimits();
      applyTransform();
    });
  }

  // ----------------- Collapse/expand (groups) -----------------
  function buildBlocks(){
    const threadGroups = Array.from(content.querySelectorAll('g.thread-block'));
    const blocksLocal = [];
    for (const tg of threadGroups) {
      const th = tg.dataset.thread;
      const hr = tg.querySelector('rect');
      if (!hr) continue;
      const y = parseFloat(hr.getAttribute('y'));
      const h = parseFloat(hr.getAttribute('height'));
      blocksLocal.push({thread: th, y: y, h: h, top: y + h, hidden: false, textNode: tg.querySelector('text.thread-label') || tg.querySelector('text')});
    }
    blocksLocal.sort((a,b)=>a.y - b.y);
    for (let i=0;i<blocksLocal.length;i++){
      blocksLocal[i].bottom = (i+1 < blocksLocal.length) ? blocksLocal[i+1].y : contentHeight;
    }
    return blocksLocal;
  }
  let blocks = buildBlocks();

  function toggleBlockByThread(threadId, headerTextNode) {
    const block = blocks.find(b => b.thread === threadId);
    if (!block) return;
    block.hidden = !block.hidden;
    if (headerTextNode) headerTextNode.textContent = (block.hidden ? '▶ ' : '▼ ') + (block.thread || '');
    const taskGroups = Array.from(content.querySelectorAll(`g.task-group[data-thread="${CSS && CSS.escape ? CSS.escape(threadId) : threadId}"]`));
    for (const tg of taskGroups) tg.style.display = block.hidden ? 'none' : '';
  }
  function collapseAll(collapse) {
    for (const b of blocks) {
      b.hidden = !!collapse;
      const tg = Array.from(content.querySelectorAll('g.thread-block')).find(g => g.dataset.thread === b.thread);
      if (tg) {
        const tnode = tg.querySelector('text.thread-label') || tg.querySelector('text');
        if (tnode) tnode.textContent = (b.hidden ? '▶ ' : '▼ ') + (b.thread || '');
      }
      const taskGroups = Array.from(content.querySelectorAll(`g.task-group[data-thread="${CSS && CSS.escape ? CSS.escape(b.thread) : b.thread}"]`));
      for (const tg2 of taskGroups) tg2.style.display = b.hidden ? 'none' : '';
    }
  }
  for (const tg of content.querySelectorAll('g.thread-block')) {
    const th = tg.dataset.thread;
    const txt = tg.querySelector('text.thread-label') || tg.querySelector('text');
    if (txt) {
      txt.style.cursor = 'pointer';
      txt.addEventListener('click', () => toggleBlockByThread(th, txt));
    }
  }
  if (btnCollapseAll) btnCollapseAll.addEventListener('click', ()=> collapseAll(true));
  if (btnExpandAll) btnExpandAll.addEventListener('click', ()=> collapseAll(false));

  // ----------------- Tooltip -----------------
  svg.addEventListener('mousemove', function(ev){
    const target = ev.target;
    if (target && target.classList && (target.classList.contains('task') || target.classList.contains('task-rect'))) {
      const args = target.dataset.args || '';
      const start = target.dataset.start;
      const end = target.dataset.end;
      tooltip.style.display = 'block';
      tooltip.textContent = args + '\n' + start + ' - ' + end + ' μs';
      tooltip.style.left = (ev.pageX + 12) + 'px';
      tooltip.style.top = (ev.pageY + 12) + 'px';
    } else {
      if (!dragging) tooltip.style.display = 'none';
    }
  });
  svg.addEventListener('mouseleave', ()=> tooltip.style.display = 'none');

  // ----------------- Minimap draw & update -----------------
  drawMinimapOverview();
  function drawMinimapOverview(){
    // clear previous
    while (miniTasksGroup.firstChild) miniTasksGroup.removeChild(miniTasksGroup.firstChild);
    const rowsTotal = total_rows || 1;
    const rowH = Math.max(2, Math.floor((MINIMAP_HEIGHT - 4) / Math.max(1, rowsTotal)));
    let rowIndex = 0;
    for (let ti=0; ti<threadLayouts.length; ++ti) {
      const tl = threadLayouts[ti];
      for (const pair of tl.assigned) {
        const t = pair.task;
        const y = Math.floor(rowIndex * rowH);
        const miniX = xToMiniX(timeToX(t.start));
        const miniW = Math.max(1, xToMiniX(timeToX(t.end)) - miniX);
        const r = document.createElementNS(svgNS,'rect');
        r.setAttribute('x', miniX);
        r.setAttribute('y', y);
        r.setAttribute('width', miniW);
        r.setAttribute('height', Math.max(1,rowH-1));
        r.setAttribute('fill', (t.color!==null && t.color!==undefined) ? colorFromInt(t.color) : colorFromString(t.args || ""));
        miniTasksGroup.appendChild(r);
        rowIndex++;
      }
    }
  }

  function updateMiniVisible(){
    // compute visible content bounds
    const vp = container.getBoundingClientRect();
    const vpW = vp.width;
    const x_left_content = (-panX) / scale;
    const x_right_content = (vpW - panX) / scale;
    const xL = Math.max(0, x_left_content);
    const xR = Math.min(contentWidth, x_right_content);
    const miniX = xToMiniX(xL);
    const miniW = Math.max(2, xToMiniX(xR) - miniX);
    miniVisible.setAttribute('x', miniX);
    miniVisible.setAttribute('y', 0);
    miniVisible.setAttribute('width', miniW);
    miniVisible.setAttribute('height', MINIMAP_HEIGHT);
  }

  // ----------------- Init & resize -----------------
  updatePanLimits();
  applyTransform();
  updateMiniVisible();

  window.addEventListener('resize', ()=>{
    // recompute anything that depends on container size
    blocks = buildBlocks();
    updatePanLimits();
    drawMinimapOverview();
    applyTransform();
    updateMiniVisible();
  });

  // ----------------- computeMaxCharsForScreenWidth (uses cached measure) -----------------
  // Note: this version expects available_screen_px expressed in screen px.
  function computeMaxCharsForScreenWidth(fullStr, available_screen_px, scaleParam) {
    // scaleParam optional — if not needed pass 1
    const scaleUsed = scaleParam || 1;
    if (!fullStr) return 0;
    const fullUnscaled = measureUnscaledTextWidth(fullStr); // CSS px at default font-size
    const fullScreen = fullUnscaled * scaleUsed;
    if (fullScreen <= available_screen_px) return fullStr.length;
    // average unscaled char
    const avgUnscaled = fullUnscaled / Math.max(1, fullStr.length);
    const avgScreen = avgUnscaled * scaleUsed;
    let guess = Math.floor(available_screen_px / Math.max(1, avgScreen));
    guess = Math.max(0, Math.min(fullStr.length, guess));
    // refine downward if necessary
    let attempts = 0;
    while (guess > 0 && attempts < 40) {
      const w = measureUnscaledSubstringWidth(fullStr, guess) * scaleUsed;
      if (w <= available_screen_px) break;
      guess = Math.max(0, Math.floor(guess * 0.9));
      attempts++;
    }
    // refine upward
    attempts = 0;
    while (guess < fullStr.length && attempts < 40) {
      const wn = measureUnscaledSubstringWidth(fullStr, guess+1) * scaleUsed;
      if (wn <= available_screen_px) guess++;
      else break;
      attempts++;
    }
    return guess;
  }

  // ----------------- end -----------------

})();
