// renderer.js
// Loads static/trace.json, builds SVG timeline, adds zoom/pan, collapse, tooltip.
// Variant A: truncates labels based on avg char width.

(async function(){
  const container = document.getElementById('svg-container');
  const tooltip = document.getElementById('tooltip');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomValue = document.getElementById('zoomValue');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnReset = document.getElementById('btnReset');
  const btnCollapseAll = document.getElementById('btnCollapseAll');
  const btnExpandAll = document.getElementById('btnExpandAll');

  const resp = await fetch('trace.json');
  if (!resp.ok) {
    container.innerText = 'Не удалось загрузить trace.json (проверьте, что вы запустили локальный HTTP-сервер и поместили файл в тот же каталог).';
    return;
  }
  const data = await resp.json();

  // layout params
  const width_px = 1400;
  const left_margin = 200;
  const row_height = 20;
  const row_padding = 6;
  const header_h = 40;
  const track_spacing = 12;

  // build flat list and compute rows per thread (greedy)
  function assignRows(tasks) {
    tasks.sort((a,b)=> a.start - b.start || a.end - b.end);
    const rowsEnd = [];
    const assigned = [];
    for (const t of tasks) {
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

  const threads = data.threads;
  // compute global time
  const global_start = data.global_start;
  const global_end = data.global_end;
  function timeToX(us) {
    const rel = (us - global_start) / (global_end - global_start);
    return left_margin + rel * (width_px - left_margin - 40);
  }

  // prepare svg
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', width_px);
  // compute rows count
  let total_rows = 0;
  const threadLayouts = [];
  for (const th of threads) {
    const {assigned, rowsCount} = assignRows(th.tasks);
    threadLayouts.push({id: th.id, assigned, rowsCount});
    total_rows += rowsCount;
  }
  const total_height = Math.round(header_h + total_rows * (row_height + row_padding) + threads.length * track_spacing + 100);
  svg.setAttribute('height', total_height);
  svg.setAttribute('id', 'timeline-svg');
  svg.style.touchAction = 'none';

  // content group for pan/zoom
  const content = document.createElementNS(svgNS, 'g');
  content.setAttribute('id','content');
  svg.appendChild(content);

  // time ruler
  const ticks = 8;
  for (let i=0;i<=ticks;i++){
    const t_us = global_start + (global_end - global_start) * i / ticks;
    const x = timeToX(t_us);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', 0); line.setAttribute('y2', header_h-6);
    line.setAttribute('stroke', '#eee');
    content.appendChild(line);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', x+3); text.setAttribute('y', header_h-10);
    text.setAttribute('class','time-label');
    text.textContent = Math.round(t_us) + ' μs';
    content.appendChild(text);
  }

  // draw threads and tasks
  let row_index_global = 0;
  for (const thLayout of threadLayouts) {
    const th = thLayout.id;
    // header rect
    const headerY = header_h + row_index_global * (row_height + row_padding) + (row_index_global ? track_spacing*(row_index_global/row_index_global) : 0) - (row_index_global===0?0:0); // simple placement
    const headerH = row_height + row_padding;
    const hdrRect = document.createElementNS(svgNS, 'rect');
    hdrRect.setAttribute('x', 0);
    hdrRect.setAttribute('y', headerY);
    hdrRect.setAttribute('width', width_px);
    hdrRect.setAttribute('height', headerH);
    hdrRect.setAttribute('fill', '#f8f8f8');
    content.appendChild(hdrRect);
    const hdrText = document.createElementNS(svgNS, 'text');
    hdrText.setAttribute('x', 8);
    hdrText.setAttribute('y', headerY + headerH/1.8);
    hdrText.setAttribute('class', 'thread-label');
    hdrText.textContent = '▶ ' + th;
    content.appendChild(hdrText);

    // tasks
    for (const pair of thLayout.assigned) {
      const t = pair.task;
      const r = pair.row;
      const x = timeToX(t.start);
      const w = Math.max(2, timeToX(t.end) - x);
      const y = header_h + (row_index_global + r) * (row_height + row_padding) ; // simple
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', w); rect.setAttribute('height', row_height);
      // color: deterministic from args if color==null
      const fill = t.color !== null && t.color !== undefined ? colorFromInt(t.color) : colorFromString(t.args || "");
      rect.setAttribute('fill', fill);
      rect.setAttribute('class','task-rect task');
      rect.dataset.args = t.args;
      rect.dataset.start = t.start;
      rect.dataset.end = t.end;
      rect.dataset.thread = th;
      content.appendChild(rect);

      // Variant A: truncate label based on avg char width
      const avg_char_px = 7.0;
      const pad_left = 4;
      const pad_right = 4;
      const available_px = Math.max(0, w - pad_left - pad_right);
      const max_chars = Math.floor(available_px / avg_char_px);
      let raw_label = (t.args || "").replace(/\n/g, " ").trim();
      let disp = '';
      if (max_chars <= 0) {
        disp = '';
      } else if (raw_label.length > max_chars) {
        if (max_chars <= 1) disp = '…'; else disp = escapeXml(raw_label.slice(0, max_chars-1)) + '…';
      } else {
        disp = escapeXml(raw_label);
      }
      if (available_px >= 6 && disp.length > 0) {
        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', x + pad_left);
        text.setAttribute('y', y + row_height*0.7);
        text.setAttribute('class','task-label');
        text.textContent = disp;
        content.appendChild(text);
      }
    }

    row_index_global += thLayout.rowsCount;
  }

  // append svg to container
  container.appendChild(svg);

  // ---------- zoom/pan state ----------
  let scale = 1.0, panX = 0, panY = 0;
  function applyTransform(){
    content.setAttribute('transform', `translate(${panX} ${panY}) scale(${scale})`);
    zoomSlider.value = scale;
    zoomValue.textContent = scale.toFixed(2) + '×';
  }

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
    applyTransform();
  }

  function zoomTo(newScale, clientX, clientY){
    if (newScale <= 0) return;
    const factor = newScale/scale;
    zoomAt(factor, clientX, clientY);
  }

  btnZoomIn.addEventListener('click', ()=>{
    const vp = svg.getBoundingClientRect();
    zoomAt(1.2, vp.width/2, vp.height/2);
  });
  btnZoomOut.addEventListener('click', ()=>{
    const vp = svg.getBoundingClientRect();
    zoomAt(1/1.2, vp.width/2, vp.height/2);
  });
  btnReset.addEventListener('click', ()=>{
    scale = 1.0; panX = 0; panY = 0; applyTransform();
  });
  zoomSlider.addEventListener('input', (ev)=>{
    const newScale = parseFloat(ev.target.value);
    const vp = svg.getBoundingClientRect();
    zoomTo(newScale, vp.width/2, vp.height/2);
  });

  svg.addEventListener('wheel', function(ev){
    ev.preventDefault();
    const delta = ev.deltaY;
    const factor = delta > 0 ? 1/1.12 : 1.12;
    zoomAt(factor, ev.clientX, ev.clientY);
  }, {passive:false});

  // pan by dragging
  let dragging = false, lastX=0, lastY=0;
  svg.addEventListener('mousedown', function(ev){
    if (ev.button !== 0) return;
    dragging = true; lastX = ev.clientX; lastY = ev.clientY;
    svg.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(ev){
    if (!dragging) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    panX += dx; panY += dy;
    lastX = ev.clientX; lastY = ev.clientY;
    applyTransform();
  });
  window.addEventListener('mouseup', function(ev){
    if (dragging) { dragging = false; svg.style.cursor = 'default'; }
  });

  // collapse/expand
  function buildBlocks(){
    const headerRects = Array.from(content.querySelectorAll('rect')).filter(r => r.getAttribute('fill') === '#f8f8f8');
    const textNodes = Array.from(content.querySelectorAll('text'));
    const blocks = [];
    for (const hr of headerRects){
      const y = parseFloat(hr.getAttribute('y'));
      const h = parseFloat(hr.getAttribute('height'));
      let label = null;
      for (const t of textNodes){
        const ty = parseFloat(t.getAttribute('y')||-9999);
        if (Math.abs(ty - (y + h/1.8)) < 6){
          label = t.textContent.replace('▶ ',''); 
          // set click handler
          t.style.cursor = 'pointer';
          t.addEventListener('click', ()=> toggleBlock(y + h, t));
          break;
        }
      }
      blocks.push({y,y,h,label,top: y + h, bottom: 0, hidden:false});
    }
    blocks.sort((a,b)=>a.y-b.y);
    for (let i=0;i<blocks.length;i++){
      blocks[i].bottom = (i+1<blocks.length) ? blocks[i+1].y : parseFloat(svg.getAttribute('height'));
    }
    return blocks;
  }
  const blocks = buildBlocks();

  function toggleBlock(top, textNode){
    const block = blocks.find(b => Math.abs(b.top - top) < 1);
    if (!block) return;
    block.hidden = !block.hidden;
    if (textNode) textNode.textContent = (block.hidden ? '▶ ' : '▼ ') + (block.label || '');
    // toggle tasks / labels
    const rects = Array.from(content.querySelectorAll('rect.task'));
    for (const r of rects){
      const ry = parseFloat(r.getAttribute('y')) + parseFloat(r.getAttribute('height'))/2;
      if (ry >= block.top && ry < block.bottom) r.style.display = block.hidden ? 'none' : '';
    }
    const texts = Array.from(content.querySelectorAll('text'));
    for (const t of texts){
      const ty = parseFloat(t.getAttribute('y')||-9999);
      if (ty >= block.top && ty < block.bottom){
        if (!(ty >= block.y && ty < block.y + block.h)) t.style.display = block.hidden ? 'none' : '';
      }
    }
  }

  btnCollapseAll.addEventListener('click', ()=> {
    for (const b of blocks) {
      b.hidden = true;
      const headerText = Array.from(content.querySelectorAll('text')).find(t => Math.abs(parseFloat(t.getAttribute('y')||-9999) - (b.y + b.h/1.8)) < 6);
      if (headerText) headerText.textContent = '▶ ' + (b.label || '');
    }
    // hide elements
    const rects = Array.from(content.querySelectorAll('rect.task'));
    for (const r of rects) {
      const ry = parseFloat(r.getAttribute('y')) + parseFloat(r.getAttribute('height'))/2;
      for (const b of blocks) if (ry >= b.top && ry < b.bottom) { r.style.display = 'none'; break; }
    }
    const texts = Array.from(content.querySelectorAll('text'));
    for (const t of texts) {
      const ty = parseFloat(t.getAttribute('y')||-9999);
      for (const b of blocks) if (ty >= b.top && ty < b.bottom) { if (!(ty >= b.y && ty < b.y + b.h)) t.style.display = 'none'; }
    }
  });
  btnExpandAll.addEventListener('click', ()=> {
    for (const b of blocks) {
      b.hidden = false;
      const headerText = Array.from(content.querySelectorAll('text')).find(t => Math.abs(parseFloat(t.getAttribute('y')||-9999) - (b.y + b.h/1.8)) < 6);
      if (headerText) headerText.textContent = '▼ ' + (b.label || '');
    }
    const rects = Array.from(content.querySelectorAll('rect.task'));
    for (const r of rects) r.style.display = '';
    const texts = Array.from(content.querySelectorAll('text'));
    for (const t of texts) t.style.display = '';
  });

  // tooltip
  svg.addEventListener('mousemove', function(ev){
    const target = ev.target;
    if (target && target.classList && target.classList.contains('task')) {
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

  applyTransform();

  // helpers: deterministic colors
  function colorFromInt(x){
    x = Number(x)|0;
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
  function escapeXml(s){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'})[c]); }

})();
