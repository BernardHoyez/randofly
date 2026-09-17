// app.js — orchestration UI : import du tracé, calcul du survol, aperçu 2D,
// génération et téléchargement du KMZ (gx:Tour) pour Google Earth.

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  importError: document.getElementById('import-error'),
  panelSettings: document.getElementById('panel-settings'),
  altitudeInput: document.getElementById('altitude-input'),
  speedInput: document.getElementById('speed-input'),
  pitchInput: document.getElementById('pitch-input'),
  pauseInput: document.getElementById('pause-input'),
  summary: document.getElementById('summary'),
  previewSvg: document.getElementById('preview-svg'),
  btnGenerate: document.getElementById('btn-generate'),
  btnToggleKml: document.getElementById('btn-toggle-kml'),
  kmlPreview: document.getElementById('kml-preview'),
  exportStatus: document.getElementById('export-status'),
  globalError: document.getElementById('global-error'),
};

let flightPath = null;
let waypoints = [];

// ---------- Bandeau d'erreur global ----------
// Objectif : qu'aucune erreur (JS, réseau) ne reste invisible dans la seule
// console du navigateur. Tout s'affiche directement dans l'appli, dans un
// champ texte sélectionnable en un clic (ne dépend d'aucune permission).

function reportError(context, detail) {
  const text = `${context} : ${detail}`;
  const box = els.globalError.querySelector('.global-error-text');
  const existing = box.value;
  box.value = existing && !existing.includes(text) ? `${existing}\n${text}` : text;
  els.globalError.hidden = false;
  console.error(text);
}

els.globalError.querySelector('.global-error-text').addEventListener('focus', (e) => e.currentTarget.select());
els.globalError.querySelector('.global-error-text').addEventListener('click', (e) => e.currentTarget.select());
els.globalError.querySelector('.global-error-close').addEventListener('click', () => {
  els.globalError.hidden = true;
  els.globalError.querySelector('.global-error-text').value = '';
});
els.globalError.querySelector('.global-error-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const field = els.globalError.querySelector('.global-error-text');
  field.select();
  const ok = await copyToClipboard(field.value);
  btn.textContent = ok ? '✅' : '⚠️';
  setTimeout(() => { btn.textContent = '📋'; }, 1500);
});

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* on tente le repli ci-dessous */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

window.addEventListener('error', (e) => {
  reportError('Erreur JavaScript', e.message ? `${e.message} (${e.filename}:${e.lineno})` : String(e));
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportError('Erreur non gérée', reason && reason.message ? reason.message : String(reason));
});

// ---------- Import ----------

['dragover', 'dragenter'].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragover'); })
);
els.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  hideError();
  els.btnGenerate.disabled = true;
  els.btnGenerate.textContent = '⏳ Analyse du tracé…';
  try {
    const { track, waypoints: rawWaypoints } = await parseTrackFile(file);
    els.btnGenerate.textContent = '⏳ Calcul du profil altimétrique…';
    flightPath = await buildFlightPath(track, (msg) => { els.btnGenerate.textContent = `⏳ ${msg}`; });
    waypoints = attachWaypointDistances(rawWaypoints, flightPath);

    updateSummary();
    drawPreviewSVG(flightPath, waypoints);
    els.kmlPreview.hidden = true;
    els.kmlPreview.value = '';
    els.btnToggleKml.textContent = 'Voir le KML généré';
    els.panelSettings.hidden = false;
  } catch (err) {
    showError(err.message || String(err));
    reportError('Échec du traitement du fichier', err.message || String(err));
  } finally {
    els.btnGenerate.disabled = false;
    els.btnGenerate.textContent = '⬇️ Générer et télécharger le KMZ';
  }
}

function attachWaypointDistances(rawWaypoints, path) {
  return rawWaypoints.map((wp) => {
    let bestDist = 0, bestD2 = Infinity;
    for (const p of path.points) {
      const dLat = p.lat - wp.lat, dLon = p.lon - wp.lon;
      const d2 = dLat * dLat + dLon * dLon;
      if (d2 < bestD2) { bestD2 = d2; bestDist = p.dist; }
    }
    return { ...wp, dist: bestDist };
  });
}

function currentSettings() {
  return {
    altitudeOffset: parseFloat(els.altitudeInput.value) || 150,
    speedKmh: parseFloat(els.speedInput.value) || 40,
    tilt: parseFloat(els.pitchInput.value) || 68,
    waypointPauseS: parseFloat(els.pauseInput.value) || 0,
  };
}

function updateSummary() {
  const km = (flightPath.totalDistance / 1000).toFixed(2);
  const { speedKmh } = currentSettings();
  const durationS = flightPath.totalDistance / (speedKmh / 3.6);
  const isFallback = flightPath.elevationSource.includes('estimée');
  els.summary.innerHTML =
    `<strong>${km} km</strong> de tracé · ` +
    `${waypoints.length} point${waypoints.length > 1 ? 's' : ''} d'intérêt · ` +
    `altitude sol : <strong>${flightPath.elevationSource}</strong> · ` +
    `durée du survol estimée : <strong>${formatTime(durationS)}</strong> · ` +
    `${flightPath.points.length} images caméra` +
    (isFallback
      ? `<br><span class="warning">⚠ Le service d'altimétrie IGN n'a pas répondu à temps : le survol se fera à altitude constante, sans suivre le relief réel du terrain. Réessayez plus tard, ou utilisez un fichier GPX contenant déjà des altitudes.</span>`
      : '');
}
[els.speedInput, els.altitudeInput, els.pitchInput, els.pauseInput].forEach((input) => {
  input.addEventListener('input', () => { if (flightPath) updateSummary(); });
});

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function showError(msg) { els.importError.textContent = msg; els.importError.hidden = false; }
function hideError() { els.importError.hidden = true; }

// ---------- Aperçu 2D (SVG, sans fond de carte) ----------

function drawPreviewSVG(path, wps) {
  const svg = els.previewSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const refLat = path.points[0].lat, refLon = path.points[0].lon;
  const xy = path.points.map((p) => toLocalXY(p.lat, p.lon, refLat, refLon));
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);

  const w = 400, h = 260, pad = 22;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const toSvg = ([x, y]) => [
    pad + (x - minX) * scale,
    h - pad - (y - minY) * scale, // Y inversé : le nord vers le haut
  ];

  const ns = 'http://www.w3.org/2000/svg';
  const d = xy.map((p, i) => { const [sx, sy] = toSvg(p); return `${i === 0 ? 'M' : 'L'}${sx.toFixed(1)},${sy.toFixed(1)}`; }).join(' ');
  const pathEl = document.createElementNS(ns, 'path');
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('fill', 'none');
  pathEl.setAttribute('stroke', '#5ec9ff');
  pathEl.setAttribute('stroke-width', '2.5');
  svg.appendChild(pathEl);

  const addDot = (svgPt, color, r) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', svgPt[0]); c.setAttribute('cy', svgPt[1]); c.setAttribute('r', r);
    c.setAttribute('fill', color); c.setAttribute('stroke', '#0b1220'); c.setAttribute('stroke-width', '1');
    svg.appendChild(c);
  };
  addDot(toSvg(xy[0]), '#4caf50', 5); // départ
  addDot(toSvg(xy[xy.length - 1]), '#ff6b6b', 5); // arrivée
  for (const wp of wps) {
    const p = toLocalXY(wp.lat, wp.lon, refLat, refLon);
    addDot(toSvg(p), '#ffb454', 4);
  }
}

// ---------- Génération et téléchargement du KMZ ----------

els.btnGenerate.addEventListener('click', async () => {
  if (!flightPath) return;
  els.btnGenerate.disabled = true;
  const originalLabel = els.btnGenerate.textContent;
  els.btnGenerate.textContent = '⏳ Génération…';
  try {
    const kml = buildGxTourKML(flightPath, waypoints, currentSettings());
    const zip = new JSZip();
    zip.file('doc.kml', kml);
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'randofly.kmz';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    showExportStatus('Fichier téléchargé : randofly.kmz');
    setTimeout(hideExportStatus, 4000);
  } catch (err) {
    reportError('Échec de la génération du KMZ', err.message || String(err));
  } finally {
    els.btnGenerate.disabled = false;
    els.btnGenerate.textContent = originalLabel;
  }
});

els.btnToggleKml.addEventListener('click', () => {
  if (!flightPath) return;
  if (els.kmlPreview.hidden) {
    els.kmlPreview.value = buildGxTourKML(flightPath, waypoints, currentSettings());
    els.kmlPreview.hidden = false;
    els.btnToggleKml.textContent = 'Masquer le KML';
  } else {
    els.kmlPreview.hidden = true;
    els.btnToggleKml.textContent = 'Voir le KML généré';
  }
});

function showExportStatus(msg) { els.exportStatus.textContent = msg; els.exportStatus.hidden = false; }
function hideExportStatus() { els.exportStatus.hidden = true; }

// ---------- Service worker ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
