// flight.js — construit le chemin de survol à partir du tracé brut :
// lissage (Catmull-Rom), ré-échantillonnage à pas fixe, profil d'altitude,
// puis fonctions d'interpolation position/cap le long du parcours.

async function buildFlightPath(track, onProgress) {
  const refLat = track[0].lat, refLon = track[0].lon;
  const rawXY = track.map((p) => toLocalXY(p.lat, p.lon, refLat, refLon));

  // Lissage : évite les angles vifs entre points bruts du GPS
  const smoothed = catmullRomSmooth(rawXY, 12);

  // Ré-échantillonnage à espacement constant (résolution spatiale de la caméra,
  // indépendante de la vitesse de survol choisie ensuite).
  const totalLen = polylineLength(smoothed);
  const spatialStep = Math.min(25, Math.max(2, totalLen / 600));
  const { points: evenXY, cumDist } = resampleEvenly(smoothed, spatialStep);

  const evenLatLon = evenXY.map(([x, y]) => fromLocalXY(x, y, refLat, refLon));

  if (onProgress) onProgress("Calcul du profil altimétrique…");
  const profile = await buildElevationProfile(track, evenLatLon, cumDist, onProgress);

  // L'altitude de survol (ground + offset) n'est PAS figée ici : elle est
  // recalculée à la volée à partir du curseur d'altitude, pour permettre un
  // réglage en direct sans reconstruire tout le chemin.
  const points = evenLatLon.map(([lat, lon], i) => {
    const ground = interpolateElevation(profile, cumDist[i]);
    return { lat, lon, ground, dist: cumDist[i] };
  });

  // Cap (bearing) vers le point suivant, légèrement lissé pour éviter les
  // à-coups de rotation caméra dans les virages serrés.
  let prevBearing = null;
  for (let i = 0; i < points.length; i++) {
    const next = points[Math.min(i + 1, points.length - 1)];
    const raw = bearingDeg(points[i].lat, points[i].lon, next.lat, next.lon);
    if (prevBearing === null) prevBearing = raw;
    const smoothedBearing = prevBearing + shortestAngleDelta(prevBearing, raw) * 0.35;
    points[i].bearing = smoothedBearing;
    prevBearing = smoothedBearing;
  }

  return {
    points,
    totalDistance: cumDist[cumDist.length - 1],
    elevationSource: profile.source,
  };
}

// Interpole position/sol/cap sur le chemin de vol pour une distance parcourue
// donnée (mètres). L'altitude réelle de survol (ground + réglage utilisateur)
// est ajoutée par l'appelant, pour rester réglable en direct.
function flightPointAtDistance(flightPath, distance) {
  const pts = flightPath.points;
  const d = Math.max(0, Math.min(distance, flightPath.totalDistance));
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].dist <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const span = b.dist - a.dist || 1;
  const t = (d - a.dist) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ground: a.ground + (b.ground - a.ground) * t,
    bearing: a.bearing + shortestAngleDelta(a.bearing, b.bearing) * t,
    progress: d / flightPath.totalDistance,
  };
}
