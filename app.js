// app.js — orchestration UI + carte 3D + lecture du survol + export vidéo

const IGN_ORTHO_URL =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
  '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM' +
  '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  importError: document.getElementById('import-error'),
  panelSettings: document.getElementById('panel-settings'),
  panelMap: document.getElementById('panel-map'),
  altitudeInput: document.getElementById('altitude-input'),
  speedInput: document.getElementById('speed-input'),
  pitchInput: document.getElementById('pitch-input'),
  summary: document.getElementById('summary'),
  btnRecompute: document.getElementById('btn-recompute'),
  map: document.getElementById('map'),
  waypointLabel: document.getElementById('waypoint-label'),
  loadingOverlay: document.getElementById('loading-overlay'),
  btnPlay: document.getElementById('btn-play'),
  btnPause: document.getElementById('btn-pause'),
  btnRestart: document.getElementById('btn-restart'),
  progress: document.getElementById('progress'),
  timeLabel: document.getElementById('time-label'),
  btnOverview: document.getElementById('btn-overview'),
  btnExport: document.getElementById('btn-export'),
  exportStatus: document.getElementById('export-status'),
};

let map = null;
let flightPath = null;
let waypoints = []; // {lat, lon, name, dist, shown}
let currentDistance = 0;
let playing = false;
let lastFrameTime = null;
let overviewMode = true;
let recorder = null;
let recordedChunks = [];
let isRecording = false;

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
  showLoading('Lecture du fichier…');
  stopFlight();
  try {
    const { track, waypoints: rawWaypoints } = await parseTrackFile(file);
    showLoading('Analyse et lissage du tracé…');
    flightPath = await buildFlightPath(track, (msg) => showLoading(msg));
    waypoints = attachWaypointDistances(rawWaypoints, flightPath);
    currentDistance = 0;

    ensureMap();
    await mapIdle();
    drawRoute();
    fitToRoute();
    updateSummary();

    els.panelSettings.hidden = false;
    els.panelMap.hidden = false;
    hideLoading();
    goOverview();
  } catch (err) {
    hideLoading();
    showError(err.message || String(err));
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
    return { ...wp, dist: bestDist, shown: false };
  });
}

function updateSummary() {
  const km = (flightPath.totalDistance / 1000).toFixed(2);
  const speed = parseFloat(els.speedInput.value) || 40;
  const durationS = flightPath.totalDistance / (speed / 3.6);
  const isFallback = flightPath.elevationSource.includes('estimée');
  els.summary.innerHTML =
    `<strong>${km} km</strong> de tracé · ` +
    `${waypoints.length} point${waypoints.length > 1 ? 's' : ''} d'intérêt · ` +
    `altitude sol : <strong>${flightPath.elevationSource}</strong> · ` +
    `durée du survol estimée : <strong>${formatTime(durationS)}</strong>` +
    (isFallback
      ? `<br><span class="warning">⚠ Le service d'altimétrie IGN n'a pas répondu à temps : le survol se fera à altitude constante, sans suivre le relief réel du terrain. Réessayez plus tard, ou utilisez un fichier GPX contenant déjà des altitudes.</span>`
      : '');
}

function showError(msg) { els.importError.textContent = msg; els.importError.hidden = false; }
function hideError() { els.importError.hidden = true; }
function showLoading(msg) { els.loadingOverlay.hidden = false; els.loadingOverlay.querySelector('span').textContent = msg; }
function hideLoading() { els.loadingOverlay.hidden = true; }

// ---------- Carte ----------

function ensureMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        ortho: {
          type: 'raster',
          tiles: [IGN_ORTHO_URL],
          tileSize: 256,
          minzoom: 0,
          maxzoom: 19,
          attribution: '© IGN Géoplateforme',
        },
      },
      layers: [{ id: 'ortho', type: 'raster', source: 'ortho' }],
    },
    center: [2, 46],
    zoom: 5,
    pitch: 0,
    preserveDrawingBuffer: true, // nécessaire pour l'export vidéo du canvas
    attributionControl: true,
  });

  // Ne jamais laisser une erreur de tuile/couche interrompre le reste de
  // l'app : par défaut MapLibre logge déjà les erreurs de tuiles réseau,
  // on s'assure juste qu'aucune exception ne remonte de façon inattendue.
  map.on('error', (e) => {
    console.warn('Carte : erreur ignorée -', e && e.error ? e.error.message : e);
  });

  // Remarque : pas de couche "sky" ici — non supportée par la version de
  // MapLibre GL JS vendorisée (3.6.2), et ajouter une couche invalide dans
  // le gestionnaire 'load' interromprait les AUTRES écouteurs de cet
  // événement (dont celui qui attend que la carte soit prête), bloquant
  // l'appli sans erreur visible.
}

function mapIdle() {
  return new Promise((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', resolve);
  });
}

function drawRoute() {
  const coords = flightPath.points.map((p) => [p.lon, p.lat]);
  const geojson = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };

  if (map.getSource('route')) {
    map.getSource('route').setData(geojson);
  } else {
    map.addSource('route', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#5ec9ff', 'line-width': 3, 'line-opacity': 0.9 },
    });
  }

  document.querySelectorAll('.wp-marker').forEach((el) => el.remove());
  for (const wp of waypoints) {
    const el = document.createElement('div');
    el.className = 'wp-marker';
    el.style.cssText =
      'width:12px;height:12px;border-radius:50%;background:#ffb454;border:2px solid #0b1220;';
    new maplibregl.Marker({ element: el }).setLngLat([wp.lon, wp.lat]).addTo(map);
  }
}

function fitToRoute() {
  const lons = flightPath.points.map((p) => p.lon);
  const lats = flightPath.points.map((p) => p.lat);
  const bounds = [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
  map.fitBounds(bounds, { padding: 40, duration: 0 });
}

function goOverview() {
  overviewMode = true;
  map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  fitToRoute();
  setMarkersVisible(true);
}

function setMarkersVisible(visible) {
  document.querySelectorAll('.wp-marker').forEach((el) => { el.style.display = visible ? 'block' : 'none'; });
}

function setFreeCamera(lat, lon, alt, pitchDeg, bearingDegVal) {
  const camera = map.getFreeCameraOptions();
  camera.position = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], alt);
  camera.setPitchBearing(pitchDeg, bearingDegVal);
  map.setFreeCameraOptions(camera);
}

// ---------- Lecture du survol ----------

els.btnPlay.addEventListener('click', () => startFlight(false));
els.btnPause.addEventListener('click', pauseFlight);
els.btnRestart.addEventListener('click', () => { currentDistance = 0; renderFrame(); });
els.btnOverview.addEventListener('click', goOverview);
els.btnExport.addEventListener('click', () => { currentDistance = 0; startFlight(true); });
els.btnRecompute.addEventListener('click', updateSummary);
els.speedInput.addEventListener('change', updateSummary);
els.progress.addEventListener('input', () => {
  if (!flightPath) return;
  currentDistance = (parseInt(els.progress.value, 10) / 1000) * flightPath.totalDistance;
  renderFrame();
});

function startFlight(record) {
  if (!flightPath) return;
  overviewMode = false;
  setMarkersVisible(false);
  playing = true;
  lastFrameTime = null;
  for (const wp of waypoints) wp.shown = false;
  els.btnPlay.hidden = true;
  els.btnPause.hidden = false;
  if (record) beginRecording();
  requestAnimationFrame(tick);
}

function pauseFlight() {
  playing = false;
  els.btnPlay.hidden = false;
  els.btnPause.hidden = true;
}

function stopFlight() {
  playing = false;
  els.btnPlay.hidden = false;
  els.btnPause.hidden = true;
}

function tick(now) {
  if (!playing) return;
  if (lastFrameTime == null) lastFrameTime = now;
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  const speedKmh = parseFloat(els.speedInput.value) || 40;
  currentDistance += (speedKmh / 3.6) * dt;

  if (currentDistance >= flightPath.totalDistance) {
    currentDistance = flightPath.totalDistance;
    renderFrame();
    stopFlight();
    if (isRecording) endRecording();
    return;
  }
  renderFrame();
  requestAnimationFrame(tick);
}

function renderFrame() {
  const p = flightPointAtDistance(flightPath, currentDistance);
  const altitudeOffset = parseFloat(els.altitudeInput.value) || 150;
  const pitch = parseFloat(els.pitchInput.value) || 68;
  setFreeCamera(p.lat, p.lon, p.ground + altitudeOffset, pitch, p.bearing);

  els.progress.value = Math.round(p.progress * 1000);
  const speedKmh = parseFloat(els.speedInput.value) || 40;
  const totalS = flightPath.totalDistance / (speedKmh / 3.6);
  els.timeLabel.textContent = `${formatTime(currentDistance / (speedKmh / 3.6))} / ${formatTime(totalS)}`;

  checkWaypointProximity();
}

function checkWaypointProximity() {
  const TRIGGER_RADIUS = 40; // mètres
  for (const wp of waypoints) {
    if (!wp.shown && Math.abs(wp.dist - currentDistance) < TRIGGER_RADIUS) {
      wp.shown = true;
      showWaypointLabel(wp.name || 'Point d\'intérêt');
    }
  }
}

let waypointLabelTimer = null;
function showWaypointLabel(name) {
  els.waypointLabel.textContent = name;
  els.waypointLabel.hidden = false;
  els.waypointLabel.style.opacity = '1';
  clearTimeout(waypointLabelTimer);
  waypointLabelTimer = setTimeout(() => {
    els.waypointLabel.style.opacity = '0';
    setTimeout(() => { els.waypointLabel.hidden = true; }, 300);
  }, 2500);
}

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------- Export vidéo ----------

function beginRecording() {
  const canvas = map.getCanvas();
  const stream = canvas.captureStream(30);
  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

  recordedChunks = [];
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = () => {
    isRecording = false;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'randofly.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    showExportStatus('Vidéo exportée : randofly.webm');
    setTimeout(hideExportStatus, 4000);
  };
  recorder.start();
  isRecording = true;
  showExportStatus('Enregistrement du survol en cours…');
}

function endRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function showExportStatus(msg) { els.exportStatus.textContent = msg; els.exportStatus.hidden = false; }
function hideExportStatus() { els.exportStatus.hidden = true; }

// ---------- Service worker ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
