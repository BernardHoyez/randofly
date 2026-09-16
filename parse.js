// parse.js — lecture de fichiers GPX / KML / KMZ -> { track: [{lat,lon,ele}], waypoints: [{lat,lon,name}] }

async function parseTrackFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.kmz')) {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    let kmlEntry = null;
    zip.forEach((path, entry) => {
      if (!kmlEntry && path.toLowerCase().endsWith('.kml')) kmlEntry = entry;
    });
    if (!kmlEntry) throw new Error("Aucun fichier .kml trouvé dans ce KMZ.");
    const text = await kmlEntry.async('text');
    return parseKML(text);
  }
  const text = await file.text();
  if (name.endsWith('.gpx')) return parseGPX(text);
  if (name.endsWith('.kml')) return parseKML(text);
  // Détection par contenu si l'extension est ambiguë
  if (text.includes('<gpx')) return parseGPX(text);
  if (text.includes('<kml')) return parseKML(text);
  throw new Error("Format non reconnu (attendu : .gpx, .kml ou .kmz).");
}

function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  checkParserError(doc);

  const track = [];
  const trkpts = doc.getElementsByTagName('trkpt');
  const source = trkpts.length ? trkpts : doc.getElementsByTagName('rtept');
  for (const pt of source) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const eleEl = pt.getElementsByTagName('ele')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    track.push({ lat, lon, ele: isFinite(ele) ? ele : null });
  }

  const waypoints = [];
  for (const wpt of doc.getElementsByTagName('wpt')) {
    const lat = parseFloat(wpt.getAttribute('lat'));
    const lon = parseFloat(wpt.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const nameEl = wpt.getElementsByTagName('name')[0];
    waypoints.push({ lat, lon, name: nameEl ? nameEl.textContent.trim() : '' });
  }

  if (track.length < 2) throw new Error("Ce fichier GPX ne contient pas de tracé exploitable (trkpt/rtept).");
  return { track, waypoints };
}

function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  checkParserError(doc);

  let track = [];
  const waypoints = [];

  for (const placemark of doc.getElementsByTagName('Placemark')) {
    const nameEl = placemark.getElementsByTagName('name')[0];
    const pmName = nameEl ? nameEl.textContent.trim() : '';

    const lineStrings = placemark.getElementsByTagName('LineString');
    if (lineStrings.length && track.length === 0) {
      // On prend la première LineString rencontrée comme trace principale
      const coordEl = lineStrings[0].getElementsByTagName('coordinates')[0];
      if (coordEl) track = coordsToPoints(coordEl.textContent);
      continue;
    }

    const points = placemark.getElementsByTagName('Point');
    if (points.length) {
      const coordEl = points[0].getElementsByTagName('coordinates')[0];
      if (coordEl) {
        const pts = coordsToPoints(coordEl.textContent);
        if (pts.length) waypoints.push({ lat: pts[0].lat, lon: pts[0].lon, name: pmName });
      }
    }
  }

  if (track.length < 2) {
    throw new Error("Ce fichier KML ne contient pas de tracé exploitable (LineString).");
  }
  return { track, waypoints };
}

function coordsToPoints(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((triplet) => {
      const [lon, lat, alt] = triplet.split(',').map(Number);
      return { lat, lon, ele: isFinite(alt) ? alt : null };
    })
    .filter((p) => isFinite(p.lat) && isFinite(p.lon));
}

function checkParserError(doc) {
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error("Fichier illisible (XML invalide).");
}
