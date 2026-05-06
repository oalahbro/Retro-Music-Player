/**
 * Parse M3U / M3U8 playlist text into Track objects.
 *
 * Supported lines:
 *   #EXTM3U                          (header — ignored)
 *   #EXTINF:<seconds>,<title>        (metadata for next URL)
 *   <url or path>                    (the actual track)
 *   # ...                            (comment — ignored)
 *
 * @typedef {{ title: string, duration: number, url: string }} Track
 *
 * @param {string} text  Raw m3u file content
 * @param {string} [baseUrl]  Optional base URL for resolving relative paths
 * @returns {Track[]}
 */
export function parseM3U(text, baseUrl = '') {
  if (typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const tracks = [];

  let pendingTitle = '';
  let pendingDuration = 0;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      // #EXTINF:217,Artist - Title
      const rest = line.slice(8);
      const commaIdx = rest.indexOf(',');
      if (commaIdx >= 0) {
        pendingDuration = parseFloat(rest.slice(0, commaIdx)) || 0;
        pendingTitle = rest.slice(commaIdx + 1).trim();
      } else {
        pendingDuration = parseFloat(rest) || 0;
        pendingTitle = '';
      }
      continue;
    }

    // Skip other directives / comments
    if (line.startsWith('#')) continue;

    // Resolve URL
    let url = line;
    if (baseUrl && !/^[a-z]+:\/\//i.test(url) && !url.startsWith('//')) {
      try {
        url = new URL(url, baseUrl).href;
      } catch {
        // leave as-is
      }
    }

    const title = pendingTitle || filenameFromUrl(url);

    tracks.push({
      title,
      duration: pendingDuration,
      url,
    });

    pendingTitle = '';
    pendingDuration = 0;
  }

  return tracks;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url, 'http://x/');
    const path = u.pathname;
    const last = path.split('/').filter(Boolean).pop() || url;
    return decodeURIComponent(last).replace(/\.[^.]+$/, '');
  } catch {
    return url;
  }
}

/**
 * Format seconds as MM:SS or HH:MM:SS
 */
export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}
