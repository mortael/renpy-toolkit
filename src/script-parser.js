
import { getAssetBytes } from './assets.js';

const SKIP_RPY = new Set(['gui.rpy', 'options.rpy']);
const SKIP_RPYC = new Set(['gui.rpyc', 'options.rpyc']);
const PY_KEYWORDS = new Set([
  'True', 'False', 'None', 'and', 'or', 'not', 'if', 'else', 'elif', 'for', 'while',
  'def', 'class', 'import', 'from', 'return', 'in', 'is', 'lambda', 'pass', 'break',
  'continue', 'with', 'as', 'try', 'except', 'finally', 'raise', 'yield', 'del',
  'global', 'nonlocal', 'assert', 'async', 'await',
]);

const RENPY_GLOBALS = new Set([
  'renpy', 'config', 'store', 'ui', 'persistent', 'Character', 'Fade', 'Dissolve',
  'Position', 'Transform', 'Animation', 'Movie', 'Frame', 'Null', 'Solid', 'Text',
  'im', 'Action', 'Function', 'Return', 'Jump', 'Show', 'Hide', 'With', 'Pause',
  'Play', 'Stop', 'Queue', 'Voice', 'Style', 'Screen', 'Timer', 'MouseArea',
]);

function normRelPath(relPath) {
  return relPath.replace(/\\/g, '/').toLowerCase();
}

function isGameRpy(relPath) {
  const norm = normRelPath(relPath);
  if (!norm.endsWith('.rpy')) return false;
  if (norm.includes('/renpy/') || norm.startsWith('renpy/')) return false;
  const base = norm.split('/').pop();
  if (SKIP_RPY.has(base)) return false;
  return true;
}

function isGameRpyc(relPath) {
  const norm = normRelPath(relPath);
  if (!norm.endsWith('.rpyc') && !norm.endsWith('.rpymc')) return false;
  if (norm.includes('/renpy/') || norm.startsWith('renpy/')) return false;
  const base = norm.split('/').pop();
  if (SKIP_RPYC.has(base)) return false;
  return true;
}

function rpySiblingForRpyc(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (norm.endsWith('.rpymc')) return norm.slice(0, -1);
  if (norm.endsWith('.rpyc')) return norm.slice(0, -1);
  return null;
}

function hasSiblingRpy(fileIndex, rpycPath) {
  const rpyPath = normRelPath(rpySiblingForRpyc(rpycPath));
  return fileIndex.some(e => normRelPath(e.relPath) === rpyPath);
}

function shouldTrackVar(name) {
  const root = name.split('.')[0];
  if (PY_KEYWORDS.has(root)) return false;
  if (root === 'persistent' || root === 'store') return name.includes('.');
  if (RENPY_GLOBALS.has(root)) return false;
  return true;
}

function extractVarsFromExpr(expr) {
  const found = new Set();
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\b/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    const name = m[1];
    if (/^\d/.test(name)) continue;
    if (shouldTrackVar(name)) found.add(name);
  }
  return found;
}

function extractAssignTargets(line) {
  const targets = [];
  const dollar = line.match(/^\s*\$\s*(.+)$/);
  const code = dollar ? dollar[1] : line.trim();
  const assignRe = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=)/g;
  let m;
  while ((m = assignRe.exec(code)) !== null) {
    if (shouldTrackVar(m[1])) targets.push(m[1]);
  }
  return targets;
}

function parseMediaFromLine(trimmed, indentStr) {
  const show = trimmed.match(/^show\s+(.+)$/i);
  if (show) {
    const name = imageNameFromShowClause(show[1]);
    return { text: indentStr + '🖼 SHOW ' + show[1], type: 'media', mediaType: 'image', mediaName: name, mediaFolder: 'images' };
  }
  const scene = trimmed.match(/^scene\s+(.+)$/i);
  if (scene) {
    const name = imageNameFromShowClause(scene[1]);
    return { text: indentStr + '🎬 SCENE ' + scene[1], type: 'media', mediaType: 'image', mediaName: name, mediaFolder: 'images' };
  }
  const play = trimmed.match(/^play\s+(music|sound|audio|voice)\s+("([^"]+)"|'([^']+)'|(\S+))/i);
  if (play) {
    const path = play[3] || play[4] || play[5] || '';
    const base = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const norm = path.replace(/\\/g, '/').toLowerCase();
    const folder = norm.includes('/audio/') || norm.startsWith('audio/')
      ? 'audio'
      : (norm.split('/')[0] || 'audio');
    return {
      text: indentStr + '🔊 PLAY ' + play[1].toUpperCase() + ': ' + path,
      type: 'media',
      mediaType: 'audio',
      mediaName: base,
      mediaFolder: folder,
      mediaPath: path,
    };
  }
  return null;
}

function parseLine(line, state) {
  const indent = line.match(/^(\s*)/)[1];
  const indentStr = indent.replace(/\t/g, '    ');
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const label = trimmed.match(/^label\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*:/);
  if (label && indent.length === 0) {
    return { kind: 'label', name: label[1], text: '🏷 LABEL: ' + label[1] };
  }

  const jump = trimmed.match(/^(jump|call)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/);
  if (jump) {
    return { kind: 'transfer', text: indentStr + '↪ ' + jump[1].toUpperCase() + ' ' + jump[2], target: jump[2] };
  }

  if (/^menu\s*:/.test(trimmed)) return { kind: 'menu', text: indentStr + '❓ MENU' };
  const choice = trimmed.match(/^"([^"]*)"\s*:/);
  if (choice && state.inMenu) return { kind: 'choice', text: indentStr + '  ▸ "' + choice[1] + '"' };

  if (/^if\s+/.test(trimmed) || /^elif\s+/.test(trimmed)) {
    const cond = trimmed.replace(/^(if|elif)\s+/, '');
    return { kind: 'condition', text: indentStr + '❓ ' + trimmed.split(':')[0], condition: cond };
  }
  if (/^else\s*:/.test(trimmed)) return { kind: 'text', text: indentStr + '↳ ELSE' };

  const defaultLine = trimmed.match(/^default\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*=/);
  if (defaultLine) {
    return {
      kind: 'default',
      text: indentStr + '📌 DEFAULT ' + trimmed,
      varName: defaultLine[1],
      code: trimmed,
    };
  }

  const defineChar = trimmed.match(/^define\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*Character\s*\(\s*["']([^"']*)["']/i);
  if (defineChar) {
    return {
      kind: 'character',
      text: indentStr + '👤 ' + trimmed,
      charId: defineChar[1],
      displayName: defineChar[2],
    };
  }

  if (trimmed.startsWith('$')) {
    return { kind: 'code', text: indentStr + '⚙ ' + trimmed, code: trimmed };
  }
  if (/^python\s*:/.test(trimmed)) return { kind: 'python-block', text: indentStr + '🐍 python:' };

  const say = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+("""|'''|")/);
  if (say) {
    return { kind: 'dialogue', text: indentStr + '💬 ' + trimmed, speaker: say[1] };
  }
  const narrate = trimmed.match(/^("""|'''|")/);
  if (narrate) return { kind: 'dialogue', text: indentStr + '💬 ' + trimmed, speaker: null };

  const media = parseMediaFromLine(trimmed, indentStr);
  if (media) return { kind: 'line', ...media };

  if (/^(define|default|image|transform|screen|init|style)\b/.test(trimmed)) {
    return { kind: 'def', text: indentStr + trimmed };
  }

  return { kind: 'text', text: indentStr + trimmed };
}

export function parseRpyContent(content, relPath) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const scripts = [];
  let current = null;
  let inPython = false;
  let pythonIndent = 0;
  let inMenu = false;
  let menuIndent = 0;

  function startLabel(name, lineNo) {
    if (current) scripts.push(current);
    current = {
      id: scripts.length,
      title: name,
      location: relPath + ' (line ' + lineNo + ')',
      file: relPath,
      label: name,
      lines: [],
    };
    inPython = false;
    inMenu = false;
  }

  function ensureDefault() {
    if (!current) startLabel('(file start)', 1);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();
    const indentLen = line.match(/^(\s*)/)[1].length;

    if (inPython && trimmed && !trimmed.startsWith('#')) {
      if (indentLen <= pythonIndent && !trimmed.startsWith('$')) {
        inPython = false;
      } else {
        ensureDefault();
        current.lines.push({ type: 'code', text: line.replace(/\t/g, '    '), code: trimmed });
        continue;
      }
    }

    if (inMenu && trimmed) {
      if (indentLen <= menuIndent && !/^"[^"]*"\s*:/.test(trimmed) && !/^\s*$/.test(line)) {
        inMenu = false;
      }
    }

    const parsed = parseLine(line, { inMenu });
    if (!parsed) continue;

    if (parsed.kind === 'label') {
      startLabel(parsed.name, lineNo);
      current.lines.push({ type: 'label', text: parsed.text });
      continue;
    }

    ensureDefault();

    if (parsed.kind === 'python-block') {
      inPython = true;
      pythonIndent = indentLen;
      current.lines.push({ type: 'code', text: parsed.text });
      continue;
    }
    if (parsed.kind === 'menu') {
      inMenu = true;
      menuIndent = indentLen;
      current.lines.push({ type: 'text', text: parsed.text });
      continue;
    }

    if (parsed.kind === 'default') {
      current.lines.push({
        type: 'default',
        text: parsed.text,
        varName: parsed.varName,
        code: parsed.code,
      });
      continue;
    }
    if (parsed.kind === 'character') {
      current.lines.push({
        type: 'character',
        text: parsed.text,
        charId: parsed.charId,
        displayName: parsed.displayName,
      });
      continue;
    }
    if (parsed.kind === 'code') {
      current.lines.push({ type: 'code', text: parsed.text, code: parsed.code });
      continue;
    }
    if (parsed.kind === 'condition') {
      current.lines.push({ type: 'condition', text: parsed.text, condition: parsed.condition });
      continue;
    }
    if (parsed.kind === 'transfer') {
      current.lines.push({ type: 'transfer', text: parsed.text, target: parsed.target });
      continue;
    }
    if (parsed.kind === 'dialogue') {
      current.lines.push({ type: 'dialogue', text: parsed.text, speaker: parsed.speaker });
      continue;
    }
    if (parsed.kind === 'line' && parsed.type === 'media') {
      current.lines.push(parsed);
      continue;
    }

    current.lines.push({ type: 'text', text: parsed.text });
  }

  if (current) scripts.push(current);
  return finalizeFileScripts(scripts, relPath);
}

function finalizeFileScripts(scripts, relPath) {
  if (scripts.length === 0) return scripts;

  if (scripts[0].label === '(file start)') {
    const preamble = scripts[0];
    if (scripts.length > 1) {
      scripts[1].lines = [...preamble.lines, ...scripts[1].lines];
      scripts = scripts.slice(1);
    } else {
      const fileName = relPath.split(/[\\/]/).pop() || relPath;
      preamble.label = '(definitions)';
      preamble.title = fileName + ' (definitions)';
      preamble.location = relPath + ' (definitions, no labels)';
      preamble.isDefinitionsOnly = true;
    }
  }

  return scripts;
}

const IMAGE_MEDIA_EXT = 'jpg|jpeg|png|webp|gif|bmp|avif|webm|mp4|ogv|mkv|avi';

function fileStemFromImagePath(pathStr) {
  if (!pathStr || pathStr.startsWith('#')) return null;
  const base = pathStr.split(/[\\/]/).pop() || pathStr;
  const dot = base.lastIndexOf('.');
  return (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();
}

function extractMediaPathFromImageRhs(rhs) {
  const trimmed = (rhs || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const extPattern = new RegExp(`\\.(${IMAGE_MEDIA_EXT})$`, 'i');

  const playMatch = trimmed.match(/play\s*=\s*["']([^"']+)["']/i);
  if (playMatch && extPattern.test(playMatch[1])) return playMatch[1];

  const startQuoted = trimmed.match(/^["']([^"']+)["']/);
  if (startQuoted && extPattern.test(startQuoted[1])) return startQuoted[1];

  const quotedPathRe = new RegExp(`["']((?:[^"']+[/\\\\])?[^"']+\\.(${IMAGE_MEDIA_EXT}))["']`, 'gi');
  const quoted = [...trimmed.matchAll(quotedPathRe)].map(m => m[1]);
  if (quoted.length) return quoted[0];

  const bare = trimmed.match(new RegExp(`^((?:[\\w./\\\\-]+[/\\\\])?[\\w.\\-() ]+\\.(${IMAGE_MEDIA_EXT}))`, 'i'));
  if (bare) return bare[1].trim();

  return null;
}

function normalizeImageTag(tag) {
  return String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function imageNameFromShowClause(clause) {
  const rest = String(clause || '').trim();
  const cut = rest.split(/\s+(?:at|on|with|zorder|behind|as|onlayer)\s+/i)[0].trim();
  return normalizeImageTag(cut);
}

function parseImageRhs(rhs) {
  const trimmed = String(rhs || '').trim();
  const noComment = trimmed.split('#')[0].trim();
  if (!noComment) return null;

  const path = extractMediaPathFromImageRhs(noComment);
  if (path) return { type: 'path', value: path };

  if (/^[a-zA-Z_][a-zA-Z0-9_]*(?:\s+[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(noComment)) {
    return { type: 'alias', value: normalizeImageTag(noComment) };
  }
  return null;
}

export function resolveImageTagAliases(rawDefs) {
  const resolved = {};
  const resolving = new Set();

  function resolveTag(tag) {
    if (Object.prototype.hasOwnProperty.call(resolved, tag)) return resolved[tag];
    const def = rawDefs[tag];
    if (!def) {
      resolved[tag] = null;
      return null;
    }
    if (def.type === 'path') {
      resolved[tag] = def.value;
      return def.value;
    }
    if (def.type === 'alias') {
      if (resolving.has(tag)) {
        resolved[tag] = null;
        return null;
      }
      resolving.add(tag);
      const path = resolveTag(def.value);
      resolving.delete(tag);
      resolved[tag] = path;
      return path;
    }
    resolved[tag] = null;
    return null;
  }

  const tagToFile = {};
  Object.keys(rawDefs).forEach(tag => {
    const path = resolveTag(tag);
    if (path) tagToFile[tag] = path;
  });
  return tagToFile;
}

function collectImageDefinitions(scripts) {
  const rawDefs = {};
  const re = /^image\s+(.+?)\s*=\s*(.+)$/i;
  scripts.forEach(script => {
    script.lines.forEach(line => {
      const raw = (line.text || '').trim();
      const m = raw.match(re);
      if (!m) return;
      const tag = normalizeImageTag(m[1]);
      const parsed = parseImageRhs(m[2]);
      if (parsed) rawDefs[tag] = parsed;
    });
  });
  return resolveImageTagAliases(rawDefs);
}

export function buildIndexes(scripts) {
  const varIndex = {};
  const assetIndex = {};
  const characters = {};
  const labelBrowse = {};
  const labelRefs = {};
  const imageTagToFile = collectImageDefinitions(scripts);

  function vidx(name) {
    if (!varIndex[name]) varIndex[name] = { setters: [], checkers: [] };
    return varIndex[name];
  }

  function addRef(arr, script, detail, lineNo) {
    arr.push({
      scriptId: script.id,
      label: script.label,
      file: script.file,
      line: lineNo,
      detail: detail || '',
      eventName: script.title,
      source: 'script',
    });
  }

  function addLabelRef(target, script, lineNo, kind) {
    if (!target || script.isDefinitionsOnly) return;
    if (!labelRefs[target]) labelRefs[target] = [];
    labelRefs[target].push({
      scriptId: script.id,
      fromLabel: script.label,
      file: script.file,
      line: lineNo,
      kind,
      eventName: script.title,
    });
  }

  function registerAssetKey(folderHint, key, displayName, usage) {
    if (!folderHint || !key) return;
    if (!assetIndex[folderHint]) assetIndex[folderHint] = {};
    if (!assetIndex[folderHint][key]) assetIndex[folderHint][key] = { name: displayName, usages: [] };
    assetIndex[folderHint][key].usages.push(usage);
  }

  function registerAsset(folderHint, name, usage) {
    if (!folderHint || !name) return;
    const key = name.toLowerCase().replace(/\.[^.]+$/, '');
    registerAssetKey(folderHint, key, name, usage);
    const fileStem = fileStemFromImagePath(imageTagToFile[key]);
    if (fileStem && fileStem !== key) registerAssetKey(folderHint, fileStem, fileStem, usage);
  }

  scripts.forEach(script => {
    if (!script.isDefinitionsOnly) {
      labelBrowse[script.label] = { scriptId: script.id, file: script.file, title: script.title };
    }

    script.lines.forEach((line, lineIdx) => {
      const ref = { script, lineNo: lineIdx + 1 };

      if (line.type === 'default' && line.varName) {
        addRef(vidx(line.varName).setters, script, 'default', ref.lineNo);
      }
      if (line.type === 'character' && line.charId) {
        characters[line.charId] = {
          id: line.charId,
          displayName: line.displayName || line.charId,
          file: script.file,
          line: ref.lineNo,
          scriptId: script.id,
        };
      }
      if (line.type === 'code' && line.code) {
        extractAssignTargets(line.code).forEach(v => addRef(vidx(v).setters, script, '=', ref.lineNo));
      }
      if (line.type === 'condition' && line.condition) {
        extractVarsFromExpr(line.condition).forEach(v => addRef(vidx(v).checkers, script, line.condition, ref.lineNo));
      }
      if (line.type === 'transfer' && line.target) {
        const kind = (line.text || '').toUpperCase().includes('CALL') ? 'call' : 'jump';
        addLabelRef(line.target, script, ref.lineNo, kind);
      }
      if (line.type === 'media') {
        const folder = line.mediaFolder || 'images';
        const mediaName = line.mediaName || '';
        registerAsset(folder, mediaName, {
          scriptId: script.id,
          label: script.label,
          file: script.file,
          line: ref.lineNo,
          path: line.mediaPath || mediaName,
        });
      }
    });
  });

  return { varIndex, assetIndex, characters, labelBrowse, labelRefs, imageTagToFile };
}

async function readEntryText(entry) {
  if (typeof entry.content === 'string') return entry.content;
  if (entry.file) return entry.file.text();
  const bytes = await getAssetBytes(entry);
  return new TextDecoder('utf-8').decode(bytes);
}

async function readEntryBytes(entry) {
  if (entry.bytes) {
    return entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
  }
  if (entry.file) return new Uint8Array(await entry.file.arrayBuffer());
  return getAssetBytes(entry);
}

export async function parseGameDataFromFolder(fileIndex, { decompileRpyc } = {}) {
  const rpyEntries = fileIndex.filter(e => isGameRpy(e.relPath));
  const rpycEntries = fileIndex.filter(
    e => isGameRpyc(e.relPath) && !hasSiblingRpy(fileIndex, e.relPath),
  );
  const scripts = [];
  const files = [];
  let rpycDecompiled = 0;
  let rpyFromArchive = 0;

  for (const entry of rpyEntries) {
    let content;
    try {
      content = await readEntryText(entry);
    } catch (err) {
      console.warn('Could not read script:', entry.relPath, err);
      continue;
    }
    if (!content?.trim()) continue;
    if (entry.source === 'rpa') rpyFromArchive += 1;
    const relPath = entry.relPath.replace(/\\/g, '/');
    const fileScripts = parseRpyContent(content, relPath);
    const offset = scripts.length;
    fileScripts.forEach(s => {
      s.id = scripts.length;
      scripts.push(s);
    });
    files.push({
      path: relPath,
      labelCount: fileScripts.length,
      scriptOffset: offset,
      source: entry.source === 'rpa' ? 'rpa-rpy' : 'rpy',
    });
  }

  if (rpycEntries.length && decompileRpyc) {
    for (const entry of rpycEntries) {
      const relPath = entry.relPath.replace(/\\/g, '/');
      const pseudoRpyPath = rpySiblingForRpyc(relPath) || relPath;
      try {
        const raw = await readEntryBytes(entry);
        if (!raw?.length) continue;
        const { source } = await decompileRpyc(raw);
        const fileScripts = parseRpyContent(source, pseudoRpyPath);
        const offset = scripts.length;
        fileScripts.forEach(s => {
          s.id = scripts.length;
          s.decompiledFromRpyc = true;
          scripts.push(s);
        });
        files.push({
          path: pseudoRpyPath,
          labelCount: fileScripts.length,
          scriptOffset: offset,
          source: entry.source === 'rpa' ? 'rpa-rpyc' : 'rpyc',
          rpycPath: relPath,
        });
        rpycDecompiled += 1;
      } catch (err) {
        console.warn('RPYC decompile failed:', relPath, err);
      }
    }
  }

  const indexes = buildIndexes(scripts);
  const varNames = Object.keys(indexes.varIndex).sort((a, b) => a.localeCompare(b));

  return {
    gameTitle: 'Ren\'Py Project',
    scripts,
    files,
    varNames,
    varIndex: indexes.varIndex,
    assetIndex: indexes.assetIndex,
    characters: indexes.characters,
    labelBrowse: indexes.labelBrowse,
    labelRefs: indexes.labelRefs,
    imageTagToFile: indexes.imageTagToFile,
    _debug: {
      rpyFiles: rpyEntries.length,
      rpyFromArchive,
      rpycOnly: rpycEntries.length,
      rpycDecompiled,
      labels: scripts.length,
      vars: varNames.length,
    },
  };
}

