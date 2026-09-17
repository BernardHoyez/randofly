// tour.js — construit un document KML contenant un gx:Tour (survol Google Earth)
// à partir d'un chemin de vol déjà calculé (flight.js) : une caméra qui vole le
// long du tracé, à altitude et inclinaison données, avec pause aux waypoints.

function buildGxTourKML(flightPath, waypoints, options) {
  const {
    altitudeOffset = 150,
    tilt = 68,
    speedKmh = 40,
    waypointPauseS = 2,
    title = 'Survol RandoFly',
  } = options;

  const speedMs = Math.max(0.1, speedKmh / 3.6);
  const pts = flightPath.points;

  // Associe à chaque waypoint l'indice du point de vol le plus proche, pour
  // savoir où insérer une pause (gx:Wait) dans la playlist.
  const pauseAtIndex = new Map();
  for (const wp of waypoints) {
    const idx = nearestIndexByDist(pts, wp.dist);
    if (!pauseAtIndex.has(idx)) pauseAtIndex.set(idx, []);
    pauseAtIndex.get(idx).push(wp);
  }

  const playlist = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const isLast = i === pts.length - 1;
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const segDist = Math.max(0, next.dist - p.dist);
    const duration = isLast ? 2 : Math.max(0.3, segDist / speedMs);
    playlist.push(flyToXML(p, altitudeOffset, tilt, duration));
    if (pauseAtIndex.has(i)) {
      playlist.push(`      <gx:Wait><gx:duration>${waypointPauseS.toFixed(1)}</gx:duration></gx:Wait>`);
    }
  }

  const trackCoords = pts
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${Math.round(p.ground)}`)
    .join(' ');

  const placemarksXML = waypoints
    .map((wp) => `  <Placemark>
    <name>${escapeXML(wp.name || "Point d'intérêt")}</name>
    <Point><coordinates>${wp.lon.toFixed(6)},${wp.lat.toFixed(6)},0</coordinates></Point>
  </Placemark>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${escapeXML(title)}</name>
  <gx:Tour>
    <name>${escapeXML(title)}</name>
    <gx:Playlist>
${playlist.join('\n')}
    </gx:Playlist>
  </gx:Tour>
  <Placemark>
    <name>Tracé</name>
    <Style><LineStyle><color>ff1493ff</color><width>3</width></LineStyle></Style>
    <LineString>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${trackCoords}</coordinates>
    </LineString>
  </Placemark>
${placemarksXML}
</Document>
</kml>`;
}

function flyToXML(p, altitudeOffset, tilt, duration) {
  return `      <gx:FlyTo>
        <gx:duration>${duration.toFixed(2)}</gx:duration>
        <gx:flyToMode>smooth</gx:flyToMode>
        <Camera>
          <longitude>${p.lon.toFixed(7)}</longitude>
          <latitude>${p.lat.toFixed(7)}</latitude>
          <altitude>${Math.round(p.ground + altitudeOffset)}</altitude>
          <heading>${p.bearing.toFixed(1)}</heading>
          <tilt>${tilt}</tilt>
          <roll>0</roll>
          <altitudeMode>absolute</altitudeMode>
        </Camera>
      </gx:FlyTo>`;
}

function escapeXML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nearestIndexByDist(pts, dist) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i].dist - dist);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
