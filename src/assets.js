import JSZip from 'jszip';
import { store } from './state.js';
import { showToast, setLoading } from './utils.js';
import { readRpaFile } from './rpa.js';

export function buildFileIndex(fileList) {
  const idx = [];
  for (const f of fileList) {
    const relPath = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    idx.push({ relPath, file: f, source: 'disk' });
  }
  return idx;
}

export async function getAssetBytes(entry) {
  if (entry.getBytes) return entry.getBytes();
  if (entry.file) return new Uint8Array(await entry.file.arrayBuffer());
  throw new Error('No data source for ' + entry.relPath);
}

export function mimeForPath(relPath) {
  const fname = relPath.toLowerCase();
  if (/\.(png|jpg|jpeg|webp|gif|avif)$/.test(fname)) return 'image/' + (fname.endsWith('.jpg') || fname.endsWith('.jpeg') ? 'jpeg' : fname.slice(fname.lastIndexOf('.') + 1));
  if (/\.(ogg|opus)$/.test(fname)) return 'audio/ogg';
  if (/\.(mp3)$/.test(fname)) return 'audio/mpeg';
  if (/\.(wav)$/.test(fname)) return 'audio/wav';
  if (/\.(m4a)$/.test(fname)) return 'audio/mp4';
  if (/\.(webm)$/.test(fname)) return 'video/webm';
  if (/\.(mp4)$/.test(fname)) return 'video/mp4';
  return 'application/octet-stream';
}

export function getDecodedFilename(entry) {
  return entry.relPath.split(/[\\/]/).pop();
}

export async function resolveAssetUrl(entry) {
  const bytes = await getAssetBytes(entry);
  const blob = new Blob([bytes], { type: mimeForPath(entry.relPath) });
  return URL.createObjectURL(blob);
}

const assetUrlCache = new Map();
const videoThumbCache = new Map();

export function resolveAssetUrlCached(entry) {
  if (assetUrlCache.has(entry.relPath)) return Promise.resolve(assetUrlCache.get(entry.relPath));
  return resolveAssetUrl(entry).then(url => {
    assetUrlCache.set(entry.relPath, url);
    return url;
  });
}

function captureVideoFrame(videoUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      fn(value);
    };

    const timer = setTimeout(() => finish(reject, new Error('video thumbnail timeout')), 20000);

    const drawFrame = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) {
          finish(reject, new Error('video has no frame dimensions'));
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        finish(resolve, canvas.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        finish(reject, err);
      }
    };

    video.onerror = () => finish(reject, new Error('video decode failed'));
    video.onloadeddata = () => {
      const dur = video.duration;
      if (dur && isFinite(dur) && dur > 0.15) {
        video.currentTime = Math.min(0.25, dur * 0.05);
      } else {
        drawFrame();
      }
    };
    video.onseeked = () => drawFrame();
    video.src = videoUrl;
  });
}

export function resolveVideoThumbnailCached(entry) {
  if (videoThumbCache.has(entry.relPath)) return videoThumbCache.get(entry.relPath);
  const promise = resolveAssetUrlCached(entry)
    .then(captureVideoFrame)
    .catch(err => {
      videoThumbCache.delete(entry.relPath);
      throw err;
    });
  videoThumbCache.set(entry.relPath, promise);
  return promise;
}

export function clearAssetUrlCache() {
  for (const url of assetUrlCache.values()) URL.revokeObjectURL(url);
  assetUrlCache.clear();
  videoThumbCache.clear();
}

/** Extract every file from a parsed RPA archive (not only media). */
export async function downloadRpaArchiveAsZip(archive) {
  const source = archive?.archiveFile || archive?.archiveBytes;
  if (!archive?.index || !source) {
    showToast('Archive data not available for extract', true);
    return;
  }
  const paths = Object.keys(archive.index).sort();
  if (!paths.length) {
    showToast('Archive index is empty', true);
    return;
  }

  setLoading(true);
  try {
    const zip = new JSZip();
    let failCount = 0;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (i % 20 === 0 || i === paths.length - 1) {
        setLoading(true, `Extracting ${i + 1}/${paths.length}…`);
      }
      try {
        const bytes = await readRpaFile(path, archive.index[path], source, archive.zixMeta);
        zip.file(path.replace(/\\/g, '/'), bytes);
      } catch (err) {
        failCount++;
        console.warn('Skipped: ' + path, err);
      }
    }
    setLoading(true, 'Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stem = archive.name.replace(/\.(rpa|rpi)$/i, '');
    a.download = stem + '_extracted.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(
      'Extracted ' + archive.name + ' → ' + a.download +
      ' (' + (paths.length - failCount) + ' files' + (failCount ? ', ' + failCount + ' skipped' : '') + ')',
    );
  } catch (err) {
    showToast('Could not extract archive: ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

export async function downloadFolderAsZip(folderName, entries) {
  if (!entries.length) {
    showToast('No files to download', true);
    return;
  }
  setLoading(true);
  try {
    const zip = new JSZip();
    let failCount = 0;
    for (const entry of entries) {
      try {
        const bytes = await getAssetBytes(entry);
        zip.file(getDecodedFilename(entry), bytes);
      } catch (err) {
        failCount++;
        console.warn('Skipped: ' + entry.relPath, err);
      }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = folderName + '_assets.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setLoading(false);
    showToast('Downloaded ' + folderName + '_assets.zip (' + entries.length + ' files' + (failCount ? ', ' + failCount + ' skipped' : '') + ')');
  } catch (err) {
    setLoading(false);
    showToast('Could not build zip: ' + err.message, true);
  }
}

function fileStemFromPath(pathStr) {
  if (!pathStr) return '';
  const base = pathStr.split(/[\\/]/).pop() || pathStr;
  const dot = base.lastIndexOf('.');
  return (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();
}

function findAssetByPath(mediaPath, folderHint) {
  if (!store.fileIndex || !mediaPath) return null;
  const norm = mediaPath.replace(/\\/g, '/').toLowerCase();
  const suffix = norm.includes('/') ? norm : (folderHint ? folderHint + '/' + norm : norm);
  const bySuffix = store.fileIndex.filter(e => e.relPath.replace(/\\/g, '/').toLowerCase().endsWith(suffix));
  if (bySuffix.length === 1) return bySuffix[0];
  if (bySuffix.length > 1 && folderHint) {
    const hinted = bySuffix.find(e => e.relPath.replace(/\\/g, '/').toLowerCase().includes('/' + folderHint + '/'));
    if (hinted) return hinted;
  }
  return bySuffix[0] || null;
}

export function resolveMediaAsset(mediaName, folderHint, mediaPath) {
  if (mediaPath) {
    const fromPath = findAssetByPath(mediaPath, folderHint) || findAssetFile(fileStemFromPath(mediaPath), folderHint);
    if (fromPath) return fromPath;
  }
  const dict = store.storyData?.imageTagToFile;
  const tag = mediaName?.toLowerCase();
  if (dict && tag && dict[tag]) {
    const mapped = dict[tag];
    const mappedFolder = mapped.includes('/') || mapped.includes('\\')
      ? mapped.replace(/\\/g, '/').split('/')[0]
      : (folderHint || 'images');
    const fromTag = findAssetByPath(mapped, mappedFolder)
      || findAssetFile(fileStemFromPath(mapped), mappedFolder || folderHint || 'images');
    if (fromTag) return fromTag;
  }
  return findAssetFile(mediaName, folderHint);
}

export function findAssetFile(baseName, folderHint) {
  if (!store.fileIndex || !baseName) return null;
  const lowerBase = baseName.toLowerCase();
  const candidates = store.fileIndex.filter(e => {
    const fname = e.relPath.split(/[\\/]/).pop().toLowerCase();
    const dot = fname.lastIndexOf('.');
    const stem = dot >= 0 ? fname.slice(0, dot) : fname;
    return stem === lowerBase;
  });
  if (candidates.length === 0) return null;
  if (folderHint) {
    const hinted = candidates.find(e => {
      const lower = e.relPath.toLowerCase();
      return lower.includes('/' + folderHint + '/') || lower.includes('\\' + folderHint + '\\');
    });
    if (hinted) return hinted;
  }
  return candidates[0];
}

export function assetFolderHint(entry) {
  const norm = entry.relPath.replace(/\\/g, '/').toLowerCase();
  for (const hint of ['images', 'audio', 'video']) {
    if (norm.includes('/' + hint + '/')) return hint;
  }
  return entry.relPath.split(/[\\/]/).slice(-2, -1)[0]?.toLowerCase() || '';
}

export function getEntryFileMeta(entry) {
  if (entry.file) {
    return { size: entry.file.size, lastModified: entry.file.lastModified };
  }
  return { size: entry.byteSize || 0, lastModified: entry.archiveLastModified || 0 };
}

export function getAssetKind(filenameLower) {
  if (/\.(png|jpg|jpeg|webp|gif|avif)$/.test(filenameLower)) return 'image';
  if (/\.(ogg|opus|mp3|wav|m4a)$/.test(filenameLower)) return 'audio';
  if (/\.(webm|mp4)$/.test(filenameLower)) return 'video';
  if (/\.(rpy|rpyc|rpymc?)$/.test(filenameLower)) return 'script';
  if (/\.(ttf|otf|woff2?)$/.test(filenameLower)) return 'font';
  if (/\.(txt|json|md|yaml|yml|xml|csv)$/.test(filenameLower)) return 'text';
  return 'other';
}

export function kindIcon(kind) {
  if (kind === 'image') return '🖼';
  if (kind === 'audio') return '🔊';
  if (kind === 'video') return '🎬';
  if (kind === 'script') return '📜';
  if (kind === 'font') return '🔤';
  if (kind === 'text') return '📝';
  return '📄';
}