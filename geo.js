// geo.js — utilitaires géométriques pour RandoFly
// Toutes les fonctions travaillent en degrés (lat/lon) sauf mention contraire.

const EARTH_R = 6371000; // rayon terrestre moyen, mètres

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

// Distance grand cercle (haversine), en mètres
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(Math.min(1, a)));
}

// Cap initial (0-360°) de (lat1,lon1) vers (lat2,lon2)
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Plus petit écart signé entre deux caps (pour lisser sans faire un tour complet)
function shortestAngleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Projection équirectangulaire locale (mètres) centrée sur (refLat, refLon).
// Suffisant à l'échelle d'une randonnée (quelques dizaines de km max).
function toLocalXY(lat, lon, refLat, refLon) {
  const x = toRad(lon - refLon) * Math.cos(toRad(refLat)) * EARTH_R;
  const y = toRad(lat - refLat) * EARTH_R;
  return [x, y];
}
function fromLocalXY(x, y, refLat, refLon) {
  const lat = refLat + toDeg(y / EARTH_R);
  const lon = refLon + toDeg(x / (EARTH_R * Math.cos(toRad(refLat))));
  return [lat, lon];
}

// Catmull-Rom CENTRIPÈTE (alpha=0.5) : lisse une polyligne en passant par
// tous ses points d'origine, sans coins brusques. Contrairement à la version
// "uniforme", la variante centripète ne dépasse pas (overshoot) à
// l'extérieur des virages serrés (ex. lacets d'un sentier de montagne) — la
// trajectoire lissée reste donc plus proche du tracé réel. points: [[x,y], ...]
// en mètres locaux.
function catmullRomSmooth(points, samplesPerSegment, alpha) {
  if (alpha === undefined) alpha = 0.5;
  const n = points.length;
  if (n < 3) return points.slice();
  const out = [];

  const nextT = (t, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const d = Math.pow(dx * dx + dy * dy, alpha * 0.5);
    return t + (d || 1e-6); // évite une division par zéro si deux points sont confondus
  };
  const lerpPt = (a, b, ta, tb, t) => {
    const f = (tb - t) / (tb - ta || 1e-6);
    return [a[0] * f + b[0] * (1 - f), a[1] * f + b[1] * (1 - f)];
  };

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    const t0 = 0;
    const t1 = nextT(t0, p0, p1);
    const t2 = nextT(t1, p1, p2);
    const t3 = nextT(t2, p2, p3);

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = t1 + (t2 - t1) * (s / samplesPerSegment);
      const A1 = lerpPt(p0, p1, t0, t1, t);
      const A2 = lerpPt(p1, p2, t1, t2, t);
      const A3 = lerpPt(p2, p3, t2, t3, t);
      const B1 = lerpPt(A1, A2, t0, t2, t);
      const B2 = lerpPt(A2, A3, t1, t3, t);
      out.push(lerpPt(B1, B2, t1, t2, t));
    }
  }
  out.push(points[n - 1]);
  return out;
}

// Ré-échantillonne une polyligne [[x,y],...] à espacement constant (mètres).
// Retourne { points: [[x,y],...], cumDist: [0, d1, d2, ...] }
function resampleEvenly(points, step) {
  if (points.length < 2) return { points: points.slice(), cumDist: [0] };
  const out = [points[0]];
  const cumDist = [0];
  let acc = 0; // distance cumulée depuis le départ jusqu'au début du segment courant
  let nextTarget = step;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;
    const segEnd = acc + segLen;
    while (nextTarget <= segEnd) {
      const t = (nextTarget - acc) / segLen;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      cumDist.push(nextTarget);
      nextTarget += step;
    }
    acc = segEnd;
  }
  // point final exact, s'il n'est pas déjà quasi atteint
  const last = points[points.length - 1];
  const prevOut = out[out.length - 1];
  const dTail = Math.hypot(last[0] - prevOut[0], last[1] - prevOut[1]);
  if (dTail > 0.5) {
    out.push(last);
    cumDist.push(acc);
  }
  return { points: out, cumDist };
}

// Longueur totale d'une polyligne [[x,y],...]
function polylineLength(points) {
  let d = 0;
  for (let i = 0; i < points.length - 1; i++) {
    d += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return d;
}
