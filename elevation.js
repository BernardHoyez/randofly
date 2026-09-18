// elevation.js — altitude du sol le long du tracé.
// Priorité aux altitudes déjà présentes dans le fichier (GPX <ele> le plus souvent).
// À défaut, interrogation du service d'altimétrie IGN Géoplateforme (sans clé).

const IGN_ELEVATION_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_CHUNK_SIZE = 100; // bien en dessous de la limite de 5000 points/requête
const IGN_TIMEOUT_MS = 8000; // le service IGN connaît des lenteurs/502 intermittents : on ne bloque jamais l'appli
const IGN_MAX_RETRIES = 1;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIGNElevations(latLonPairs, onProgress) {
  const results = new Array(latLonPairs.length).fill(null);
  const nbChunks = Math.ceil(latLonPairs.length / IGN_CHUNK_SIZE);
  let chunkNum = 0;
  for (let i = 0; i < latLonPairs.length; i += IGN_CHUNK_SIZE) {
    chunkNum++;
    const chunk = latLonPairs.slice(i, i + IGN_CHUNK_SIZE);
    const lonStr = chunk.map((p) => p[1]).join('|');
    const latStr = chunk.map((p) => p[0]).join('|');
    const url = `${IGN_ELEVATION_URL}?lon=${encodeURIComponent(lonStr)}&lat=${encodeURIComponent(latStr)}&resource=ign_rge_alti_wld&delimiter=|&indent=false&zonly=true`;

    if (onProgress) onProgress(`Interrogation du service d'altimétrie IGN (bloc ${chunkNum}/${nbChunks})…`);

    let lastErr = null;
    let ok = false;
    for (let attempt = 0; attempt <= IGN_MAX_RETRIES && !ok; attempt++) {
      try {
        const resp = await fetchWithTimeout(url, IGN_TIMEOUT_MS);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const elevations = data.elevations || [];
        for (let j = 0; j < chunk.length; j++) {
          const z = typeof elevations[j] === 'number' ? elevations[j] : (elevations[j] && elevations[j].z);
          results[i + j] = isFinite(z) ? z : 0;
        }
        ok = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) {
      const reason = lastErr && lastErr.name === 'AbortError'
        ? `pas de réponse au-delà de ${IGN_TIMEOUT_MS / 1000}s`
        : (lastErr ? lastErr.message : 'erreur inconnue');
      throw new Error(`Service d'altimétrie IGN indisponible (${reason}).`);
    }
  }
  return results;
}

// samplePoints: [{lat, lon}], cumDist: distance cumulée (m) le long du tracé lissé.
// Retourne un profil { cumDist: [...], ele: [...] } utilisable pour interpoler
// l'altitude en tout point via interpolateElevation().
async function buildElevationProfile(originalTrack, smoothSamplePoints, smoothCumDist, onProgress) {
  // Beaucoup d'exports KML ("clampToGround") portent une altitude à 0 partout :
  // ce n'est pas un vrai profil, donc on l'ignore et on retombe sur l'IGN.
  const allFinite = originalTrack.length > 0 && originalTrack.every((p) => typeof p.ele === 'number' && isFinite(p.ele));
  const eleValues = allFinite ? originalTrack.map((p) => p.ele) : [];
  const hasVariation = allFinite && (Math.max(...eleValues) - Math.min(...eleValues) > 1);
  const hasEle = allFinite && hasVariation;

  if (hasEle) {
    // Profil directement dérivé des altitudes du fichier source, sans requête réseau.
    let cum = 0;
    const cumDist = [0];
    const ele = [originalTrack[0].ele];
    for (let i = 1; i < originalTrack.length; i++) {
      const a = originalTrack[i - 1], b = originalTrack[i];
      cum += haversine(a.lat, a.lon, b.lat, b.lon);
      cumDist.push(cum);
      ele.push(b.ele);
    }
    return { cumDist, ele, source: 'fichier' };
  }

  // Pas d'altitude dans le fichier : échantillonnage du tracé lissé. Pas
  // plus large possible tout en gardant un profil sensible au relief réel
  // (jusqu'à 500 requêtes, soit un point tous les ~20 m sur un tracé de 10 km).
  const totalDist = smoothCumDist[smoothCumDist.length - 1] || 1;
  const targetCount = Math.min(500, Math.max(30, Math.round(totalDist / 20)));
  const strideIdx = Math.max(1, Math.floor(smoothSamplePoints.length / targetCount));

  const sampleIdx = [];
  for (let i = 0; i < smoothSamplePoints.length; i += strideIdx) sampleIdx.push(i);
  if (sampleIdx[sampleIdx.length - 1] !== smoothSamplePoints.length - 1) {
    sampleIdx.push(smoothSamplePoints.length - 1);
  }

  const pairs = sampleIdx.map((i) => [smoothSamplePoints[i][0], smoothSamplePoints[i][1]]); // [lat, lon]
  const cumDist = sampleIdx.map((i) => smoothCumDist[i]);

  try {
    const elevations = await fetchIGNElevations(pairs, onProgress);
    return { cumDist, ele: elevations, source: 'IGN (RGE ALTI)' };
  } catch (err) {
    // Le service d'altimétrie IGN peut être temporairement indisponible
    // (lenteurs/502 connus). On ne bloque jamais l'appli : repli sur un survol
    // à altitude constante, avec un avertissement clair pour l'utilisateur.
    if (onProgress) onProgress(`⚠ ${err.message} — survol à altitude constante (sans relief du sol).`);
    return { cumDist: [0, cumDist[cumDist.length - 1] || 1], ele: [0, 0], source: 'estimée (service IGN indisponible)' };
  }
}

// Interpolation linéaire de l'altitude du sol à une distance cumulée donnée.
function interpolateElevation(profile, distance) {
  const { cumDist, ele } = profile;
  if (distance <= cumDist[0]) return ele[0];
  if (distance >= cumDist[cumDist.length - 1]) return ele[ele.length - 1];
  let lo = 0, hi = cumDist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= distance) lo = mid; else hi = mid;
  }
  const t = (distance - cumDist[lo]) / (cumDist[hi] - cumDist[lo] || 1);
  return ele[lo] + (ele[hi] - ele[lo]) * t;
}
