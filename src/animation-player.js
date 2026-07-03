import { resolveAssetUrlCached } from './assets.js';
import { openModal } from './modal.js';

export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) || [];
  const bx = b.match(re) || [];
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i] || '', bv = bx[i] || '';
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = parseInt(av, 10) - parseInt(bv, 10);
      if (diff !== 0) return diff;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

function baseNameOf(entry) {
  const fname = entry.relPath.split(/[\\/]/).pop();
  const dot = fname.lastIndexOf('.');
  return dot >= 0 ? fname.slice(0, dot) : fname;
}

export function detectSequences(imageEntries) {
  const groups = {};
  imageEntries.forEach(entry => {
    const base = baseNameOf(entry);
    const ext = entry.relPath.slice(entry.relPath.lastIndexOf('.'));
    const m = base.match(/^(.*?)(\d+)$/);
    if (!m) return;
    const prefix = m[1] + '|' + ext.toLowerCase();
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(entry);
  });
  return Object.keys(groups)
    .map(key => ({
      prefix: key.split('|')[0].replace(/[_\-]$/, '') || key.split('|')[0],
      entries: groups[key].sort((a, b) => naturalCompare(a.relPath, b.relPath)),
    }))
    .filter(g => g.entries.length >= 2)
    .sort((a, b) => b.entries.length - a.entries.length);
}

export async function openAnimationPlayer(entries) {
  const frames = entries.slice().sort((a, b) => naturalCompare(a.relPath, b.relPath));
  const wrap = document.createElement('div');
  wrap.style.minWidth = '320px';
  wrap.style.textAlign = 'center';

  const title = document.createElement('div');
  title.style.fontSize = '12px';
  title.style.color = 'var(--text-dim)';
  title.style.marginBottom = '12px';
  title.textContent = frames.length + ' frames';
  wrap.appendChild(title);

  const stage = document.createElement('div');
  stage.style.minHeight = '200px';
  stage.style.display = 'flex';
  stage.style.alignItems = 'center';
  stage.style.justifyContent = 'center';
  stage.style.marginBottom = '14px';
  stage.textContent = 'Loading frames…';
  wrap.appendChild(stage);

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.alignItems = 'center';
  controls.style.justifyContent = 'center';
  controls.style.gap = '12px';
  controls.style.marginBottom = '10px';

  const playBtn = document.createElement('button');
  playBtn.className = 'secondary';
  playBtn.textContent = '▶';
  playBtn.disabled = true;
  const fpsLabel = document.createElement('span');
  fpsLabel.style.fontSize = '12px';
  fpsLabel.style.color = 'var(--text-dim)';
  fpsLabel.textContent = 'FPS';
  const fpsInput = document.createElement('input');
  fpsInput.type = 'number';
  fpsInput.min = '1';
  fpsInput.max = '60';
  fpsInput.value = '12';
  fpsInput.style.width = '60px';
  const loopLabel = document.createElement('label');
  loopLabel.style.fontSize = '12px';
  loopLabel.style.color = 'var(--text-dim)';
  loopLabel.style.display = 'flex';
  loopLabel.style.alignItems = 'center';
  loopLabel.style.gap = '5px';
  const loopCb = document.createElement('input');
  loopCb.type = 'checkbox';
  loopCb.checked = true;
  loopCb.style.width = 'auto';
  loopLabel.appendChild(loopCb);
  loopLabel.appendChild(document.createTextNode('Loop'));

  controls.appendChild(playBtn);
  controls.appendChild(fpsLabel);
  controls.appendChild(fpsInput);
  controls.appendChild(loopLabel);
  wrap.appendChild(controls);

  const scrubRow = document.createElement('div');
  scrubRow.style.display = 'flex';
  scrubRow.style.alignItems = 'center';
  scrubRow.style.gap = '10px';
  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.min = '0';
  scrubber.max = String(frames.length - 1);
  scrubber.value = '0';
  scrubber.style.flex = '1';
  const frameLabel = document.createElement('span');
  frameLabel.style.fontSize = '11px';
  frameLabel.style.color = 'var(--text-dim)';
  frameLabel.style.fontFamily = 'Consolas, monospace';
  frameLabel.style.minWidth = '60px';
  scrubRow.appendChild(scrubber);
  scrubRow.appendChild(frameLabel);
  wrap.appendChild(scrubRow);

  openModal(wrap);

  let urls = [];
  let current = 0;
  let playing = false;
  let timer = null;

  function showFrame(i) {
    current = i;
    scrubber.value = String(i);
    frameLabel.textContent = (i + 1) + ' / ' + frames.length;
    stage.innerHTML = '';
    const img = document.createElement('img');
    img.src = urls[i];
    img.style.maxWidth = '100%';
    img.style.maxHeight = '60vh';
    img.style.borderRadius = '6px';
    stage.appendChild(img);
  }

  function stop() {
    playing = false;
    playBtn.textContent = '▶';
    if (timer) { clearInterval(timer); timer = null; }
  }

  function start() {
    if (urls.length === 0) return;
    playing = true;
    playBtn.textContent = '⏸';
    const fps = Math.max(1, Math.min(60, parseInt(fpsInput.value, 10) || 12));
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!document.getElementById('modal-overlay').classList.contains('show')) { stop(); return; }
      let next = current + 1;
      if (next >= frames.length) {
        if (!loopCb.checked) { stop(); return; }
        next = 0;
      }
      showFrame(next);
    }, 1000 / fps);
  }

  playBtn.onclick = () => { playing ? stop() : start(); };
  fpsInput.onchange = () => { if (playing) start(); };
  scrubber.oninput = () => { stop(); showFrame(parseInt(scrubber.value, 10)); };

  try {
    urls = await Promise.all(frames.map(f => resolveAssetUrlCached(f)));
    playBtn.disabled = false;
    showFrame(0);
    start();
  } catch (err) {
    stage.textContent = '(could not decode frames: ' + err.message + ')';
  }
}