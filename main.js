'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const http   = require('http');
const net    = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ─── Constants ───────────────────────────────────────────────────────────────
const PS3_PKG_MAGIC      = 0x7F504B47;
const SFO_MAGIC          = 0x00505346; // '\x00PSF' LE: 0x46535000 stored as LE = read as 0x00505346
const PNG_MAGIC          = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
const SCAN_CHUNK         = 2 * 1024 * 1024; // 2 MB scan window
const COPY_BUF_SIZE      = 4 * 1024 * 1024; // 4 MB copy buffer
const MAX_DEPTH          = 10;
const CONCURRENCY        = 16;

// ─── Security helpers ─────────────────────────────────────────────────────────
function sanitize(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, 200);
}

function guardPath(base, target) {
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path traversal detected');
  }
}

// ─── PS3 PKG Parsing ─────────────────────────────────────────────────────────

/** Detect content type from package_type field */
function contentTypeFromPkgType(pkgType) {
  switch (pkgType) {
    case 0x04: case 0x06: case 0x0F: case 0x15: return 'Game';
    case 0x0B: return 'Patch';
    case 0x05: case 0x0C: return 'DLC';
    case 0x09: return 'Demo';
    case 0x07: case 0x12: return 'Theme';
    case 0x16: case 0x17: return 'PSP';
    default:   return 'Other';
  }
}

/** Detect region from content ID prefix */
function regionFromContentId(contentId) {
  if (!contentId) return 'Other';
  const prefix = contentId.slice(0, 2).toUpperCase();
  const map = { UP: 'USA', EP: 'EUR', JP: 'JPN', BL: 'JPN', BC: 'JPN', HP: 'ASIA', KP: 'KOR' };
  return map[prefix] || 'Other';
}

/** Parse PARAM.SFO from a buffer (may be a slice from inside PKG) */
function parseSfo(buf) {
  try {
    // SFO magic bytes: 0x00, 0x50, 0x53, 0x46 ('\x00PSF')
    // Read as little-endian uint32: 0x46535000
    if (buf.length < 20) return null;
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x46535000) return null;

    const keyTableOffset  = buf.readUInt32LE(8);
    const dataTableOffset = buf.readUInt32LE(12);
    const entryCount      = buf.readUInt32LE(16);

    const result = {};
    for (let i = 0; i < entryCount; i++) {
      const entBase = 20 + i * 16;
      if (entBase + 16 > buf.length) break;
      const keyOff  = buf.readUInt16LE(entBase);
      const dataFmt = buf.readUInt16LE(entBase + 2);
      const dataLen = buf.readUInt32LE(entBase + 4);
      const dataOff = buf.readUInt32LE(entBase + 12);

      const keyStart = keyTableOffset + keyOff;
      let keyEnd = keyStart;
      while (keyEnd < buf.length && buf[keyEnd] !== 0) keyEnd++;
      const key = buf.slice(keyStart, keyEnd).toString('ascii');

      const valStart = dataTableOffset + dataOff;
      let val;
      if (dataFmt === 0x0204) { // UTF-8 string
        let end = valStart;
        while (end < buf.length && end < valStart + dataLen && buf[end] !== 0) end++;
        val = buf.slice(valStart, end).toString('utf8');
      } else if (dataFmt === 0x0404) { // uint32
        val = buf.readUInt32LE(valStart);
      } else {
        val = buf.slice(valStart, valStart + dataLen).toString('ascii').replace(/\x00/g, '');
      }
      result[key] = val;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse a PS3 PKG file. Returns a metadata object or null on failure.
 */
async function parsePkg(filePath) {
  let fd;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const stat = await fd.stat();
    const fileSize = stat.size;

    // Read main header (at least 0x90 bytes)
    const headerBuf = Buffer.alloc(0x90);
    const { bytesRead: hRead } = await fd.read(headerBuf, 0, 0x90, 0);
    if (hRead < 0x90) return null;

    // Verify magic
    const magic = headerBuf.readUInt32BE(0x00);
    if (magic !== PS3_PKG_MAGIC) return null;

    const pkgType   = headerBuf.readUInt16BE(0x06);
    const fileCount = headerBuf.readUInt32BE(0x14);

    // Content ID (0x30..0x6F, 64 bytes, null-terminated ASCII)
    let contentId = '';
    for (let i = 0x30; i < 0x70; i++) {
      if (headerBuf[i] === 0) break;
      contentId += String.fromCharCode(headerBuf[i]);
    }

    const region   = regionFromContentId(contentId);
    const baseType = contentTypeFromPkgType(pkgType);

    // Read first SCAN_CHUNK of file for SFO + icon
    const scanSize = Math.min(SCAN_CHUNK, fileSize);
    const bodyBuf  = Buffer.alloc(scanSize);
    await fd.read(bodyBuf, 0, scanSize, 0);

    // Find SFO: magic bytes 00 50 53 46
    let sfo = null;
    const sfoMagicBuf = Buffer.from([0x00, 0x50, 0x53, 0x46]);
    let sfoOff = -1;
    for (let i = 0; i <= bodyBuf.length - 4; i++) {
      if (bodyBuf[i]     === sfoMagicBuf[0] &&
          bodyBuf[i + 1] === sfoMagicBuf[1] &&
          bodyBuf[i + 2] === sfoMagicBuf[2] &&
          bodyBuf[i + 3] === sfoMagicBuf[3]) {
        sfoOff = i;
        break;
      }
    }
    if (sfoOff >= 0) {
      sfo = parseSfo(bodyBuf.slice(sfoOff));
    }

    // Find icon: PNG magic 89 50 4E 47
    let iconDataUrl = null;
    let bestPngSize = 0;
    let bestPngOff  = -1;
    for (let i = 0; i <= bodyBuf.length - 4; i++) {
      if (bodyBuf[i]     === 0x89 &&
          bodyBuf[i + 1] === 0x50 &&
          bodyBuf[i + 2] === 0x4E &&
          bodyBuf[i + 3] === 0x47) {
        // Estimate PNG size: find IEND chunk
        let pngEnd = i + 8;
        while (pngEnd + 12 <= bodyBuf.length) {
          const chunkLen  = bodyBuf.readUInt32BE(pngEnd);
          const chunkType = bodyBuf.slice(pngEnd + 4, pngEnd + 8).toString('ascii');
          pngEnd += 12 + chunkLen;
          if (chunkType === 'IEND') break;
          if (pngEnd > i + 1024 * 1024) break; // cap at 1MB per image
        }
        const pngSize = pngEnd - i;
        if (pngSize > bestPngSize && pngEnd <= bodyBuf.length) {
          bestPngSize = pngSize;
          bestPngOff  = i;
        }
      }
    }
    if (bestPngOff >= 0 && bestPngSize > 0) {
      const pngBuf = bodyBuf.slice(bestPngOff, bestPngOff + bestPngSize);
      iconDataUrl  = 'data:image/png;base64,' + pngBuf.toString('base64');
    }

    // Extract title ID from content ID: format UP0001-NPUA80055_00-...
    let titleId = '';
    if (contentId) {
      const m = contentId.match(/[A-Z]{2}\d{4}-([A-Z]{4}\d{5})/);
      if (m) titleId = m[1];
      else {
        const parts = contentId.split('-');
        if (parts.length >= 2) titleId = parts[1];
      }
    }

    const title    = (sfo && (sfo.TITLE || sfo.TITLE_0)) || titleId || path.basename(filePath, '.pkg');
    const version  = (sfo && (sfo.APP_VER || sfo.VERSION)) || '';
    const category = (sfo && sfo.CATEGORY) || baseType;
    const parentalLevel = (sfo && sfo.PARENTAL_LEVEL) || 0;

    return {
      filePath,
      fileName:    path.basename(filePath),
      fileSize,
      contentId,
      titleId,
      title,
      version,
      category,
      baseType,
      region,
      parentalLevel,
      iconDataUrl,
      isFtp: false,
      isDuplicate: false,
    };
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

// ─── Directory Walker ─────────────────────────────────────────────────────────
async function findPkgFiles(dir, signal, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  if (signal && signal.aborted) return [];
  const results = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const ent of entries) {
    if (signal && signal.aborted) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await findPkgFiles(full, signal, depth + 1);
      results.push(...sub);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.pkg')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Scanner ──────────────────────────────────────────────────────────────────
async function scanPkgs(sourceDir, sender) {
  const ac = new AbortController();
  currentAbortController = ac;

  sender.send('scan-progress', { type: 'scan-start', dir: sourceDir });

  let files;
  try {
    sender.send('scan-progress', { type: 'scan-discovering', dir: sourceDir });
    files = await findPkgFiles(sourceDir, ac.signal);
  } catch (e) {
    sender.send('scan-progress', { type: 'scan-error', error: e.message });
    return [];
  }

  if (ac.signal.aborted) {
    sender.send('scan-progress', { type: 'scan-done', total: 0, cancelled: true });
    return [];
  }

  const total = files.length;
  sender.send('scan-progress', { type: 'scan-found', total });

  const results = [];
  let done = 0;

  // Process with CONCURRENCY workers
  async function worker(queue) {
    while (queue.length > 0) {
      if (ac.signal.aborted) break;
      const f = queue.shift();
      sender.send('scan-progress', { type: 'scan-parsing', file: f, done, total });
      const item = await parsePkg(f);
      done++;
      if (item) {
        results.push(item);
        sender.send('scan-progress', { type: 'scan-result', item, done, total });
      }
    }
  }

  const queue = [...files];
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, files.length); i++) {
    workers.push(worker(queue));
  }
  await Promise.all(workers);

  // Mark duplicates by contentId
  const seen = new Map();
  for (const item of results) {
    if (item.contentId) {
      const key = item.contentId;
      if (seen.has(key)) {
        item.isDuplicate = true;
        seen.get(key).isDuplicate = true;
      } else {
        seen.set(key, item);
      }
    }
  }

  sender.send('scan-progress', {
    type: 'scan-done',
    total: results.length,
    cancelled: ac.signal.aborted
  });
  return results;
}

// ─── FTP Scanner ──────────────────────────────────────────────────────────────
async function scanPkgsFtp(cfg, sender) {
  const { Client } = require('basic-ftp');
  const ac = new AbortController();
  currentAbortController = ac;

  sender.send('scan-progress', { type: 'scan-start', dir: `ftp://${cfg.host}` });

  const client = new Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host:     cfg.host,
      port:     cfg.port || 21,
      user:     cfg.user || 'anonymous',
      password: cfg.pass || '',
      secure:   false,
    });
  } catch (e) {
    sender.send('scan-progress', { type: 'scan-error', error: e.message });
    return [];
  }

  const results = [];
  const paths   = cfg.paths || ['/dev_hdd0/packages', '/dev_usb000', '/dev_usb001'];

  async function walkFtp(remotePath, depth = 0) {
    if (depth > MAX_DEPTH || ac.signal.aborted) return;
    let list;
    try { list = await client.list(remotePath); } catch { return; }
    for (const item of list) {
      if (ac.signal.aborted) break;
      const rp = remotePath.replace(/\/+$/, '') + '/' + item.name;
      if (item.isDirectory) {
        await walkFtp(rp, depth + 1);
      } else if (item.name.toLowerCase().endsWith('.pkg')) {
        sender.send('scan-progress', { type: 'scan-parsing', file: rp, done: results.length, total: -1 });
        results.push({
          filePath:    rp,
          fileName:    item.name,
          fileSize:    item.size || 0,
          contentId:   '',
          titleId:     '',
          title:       path.basename(item.name, '.pkg'),
          version:     '',
          category:    'Other',
          baseType:    'Other',
          region:      'Other',
          iconDataUrl: null,
          isFtp:       true,
          ftpCfg:      cfg,
          isDuplicate: false,
        });
        sender.send('scan-progress', { type: 'scan-result', item: results[results.length - 1], done: results.length, total: -1 });
      }
    }
  }

  sender.send('scan-progress', { type: 'scan-discovering', dir: `ftp://${cfg.host}` });
  for (const p of paths) {
    if (ac.signal.aborted) break;
    await walkFtp(p);
  }
  client.close();

  sender.send('scan-progress', { type: 'scan-done', total: results.length, cancelled: ac.signal.aborted });
  return results;
}

// ─── File Operations ──────────────────────────────────────────────────────────
async function copyFileWithProgress(src, dest, progressCb, cancelCheck) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const srcStat  = await fs.promises.stat(src);
  const total    = srcStat.size;
  let transferred = 0;

  const rd = fs.createReadStream(src,  { highWaterMark: COPY_BUF_SIZE });
  const wr = fs.createWriteStream(dest, { highWaterMark: COPY_BUF_SIZE });

  await new Promise((resolve, reject) => {
    rd.on('data', chunk => {
      transferred += chunk.length;
      if (progressCb) progressCb(transferred, total);
      if (cancelCheck && cancelCheck()) {
        rd.destroy();
        wr.destroy();
        reject(new Error('Cancelled'));
      }
    });
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', resolve);
    rd.pipe(wr);
  });

  // Preserve timestamps
  try {
    await fs.promises.utimes(dest, srcStat.atime, srcStat.mtime);
  } catch {}
}

async function moveFileWithProgress(src, dest, progressCb, cancelCheck) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(src, dest);
    if (progressCb) {
      const size = (await fs.promises.stat(dest)).size;
      progressCb(size, size);
    }
  } catch (e) {
    if (e.code === 'EXDEV') {
      await copyFileWithProgress(src, dest, progressCb, cancelCheck);
      await fs.promises.unlink(src);
    } else {
      throw e;
    }
  }
}

function applyRenameFormat(fmt, item) {
  return fmt
    .replace(/\{TITLE_ID\}/g,   sanitize(item.titleId    || ''))
    .replace(/\{TITLE\}/g,      sanitize(item.title      || ''))
    .replace(/\{VERSION\}/g,    sanitize(item.version    || ''))
    .replace(/\{CATEGORY\}/g,   sanitize(item.category   || ''))
    .replace(/\{REGION\}/g,     sanitize(item.region     || ''))
    .replace(/\{CONTENT_ID\}/g, sanitize(item.contentId  || ''))
    .replace(/\{REQ_FW\}/g,     sanitize(item.reqFw      || ''));
}

function buildDestPath(item, destDir, layout, renameFormat) {
  const fmt    = renameFormat || '{TITLE_ID}';
  const base   = path.basename(item.filePath);
  const cat    = sanitize(item.baseType || item.category || 'Other');
  const tid    = sanitize(item.titleId  || 'UNKNOWN');

  switch (layout) {
    case 'flat':
      return path.join(destDir, base);
    case 'by-title-id':
      return path.join(destDir, tid, base);
    case 'by-category':
      return path.join(destDir, cat, tid, base);
    case 'rename':
      return path.join(destDir, applyRenameFormat(fmt, item) + '.pkg');
    case 'rename-organize':
      return path.join(destDir, cat, applyRenameFormat(fmt, item) + '.pkg');
    default:
      return path.join(destDir, base);
  }
}

// ─── Network helpers ──────────────────────────────────────────────────────────
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

async function getAllDrives() {
  const drives = [];
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"',
        { timeout: 8000 }
      );
      for (const line of stdout.split(/\r?\n/)) {
        const d = line.trim();
        if (d && d.match(/^[A-Z]:\\/i)) drives.push(d);
      }
    } catch {}
    // Brute-force A-Z probe as fallback
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const dr = `${l}:\\`;
      if (!drives.includes(dr)) {
        try {
          await fs.promises.access(dr);
          drives.push(dr);
        } catch {}
      }
    }
  } else {
    drives.push('/');
    try {
      const mounts = await fs.promises.readdir('/media');
      for (const m of mounts) drives.push('/media/' + m);
    } catch {}
    try {
      const mounts = await fs.promises.readdir('/mnt');
      for (const m of mounts) drives.push('/mnt/' + m);
    } catch {}
    try {
      const vol = await fs.promises.readdir('/Volumes');
      for (const v of vol) drives.push('/Volumes/' + v);
    } catch {}
  }
  return [...new Set(drives)];
}

// ─── Local HTTP server for remote install ─────────────────────────────────────
let pkgServer     = null;
let pkgServerPort = 0;

function startPkgServer(files, port) {
  if (pkgServer) { pkgServer.close(); pkgServer = null; }

  pkgServer = http.createServer(async (req, res) => {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);
    const matched = files.find(f => '/' + encodeURIComponent(path.basename(f)) === req.url.split('?')[0] ||
                                    '/' + path.basename(f) === reqPath);
    if (!matched) {
      res.writeHead(404);
      return res.end('Not found');
    }

    let stat;
    try { stat = await fs.promises.stat(matched); }
    catch { res.writeHead(404); return res.end('Not found'); }

    const total = stat.size;
    const rangeHdr = req.headers.range;

    let start = 0, end = total - 1;
    if (rangeHdr) {
      const m = rangeHdr.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end   = parseInt(m[2], 10);
      }
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   'application/octet-stream',
      });
    } else {
      res.writeHead(200, {
        'Accept-Ranges':  'bytes',
        'Content-Length': total,
        'Content-Type':   'application/octet-stream',
      });
    }

    const stream = fs.createReadStream(matched, { start, end });
    stream.pipe(res);
  });

  pkgServer.listen(port || 8090, '0.0.0.0');
  pkgServerPort = port || 8090;
  return pkgServerPort;
}

function stopPkgServer() {
  if (pkgServer) { pkgServer.close(); pkgServer = null; }
}

// ─── webMAN remote install ────────────────────────────────────────────────────
async function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function remoteInstall(items, ps3Ip, ps3Port, srvPort, sender) {
  const port    = parseInt(ps3Port, 10)  || 80;
  const fileSrv = parseInt(srvPort, 10) || 8090;
  const localIp = getLocalIp();

  // Start local file server
  const localFiles = items.filter(i => !i.isFtp).map(i => i.filePath);
  if (localFiles.length > 0) startPkgServer(localFiles, fileSrv);

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    sender.send('install-progress', {
      idx, total: items.length, file: item.fileName, status: 'installing', percent: 0
    });

    if (item.isFtp) {
      // Can't serve FTP items directly — send notification
      sender.send('install-progress', {
        idx, total: items.length, file: item.fileName,
        status: 'error', error: 'FTP-sourced PKGs cannot be remote-installed directly'
      });
      continue;
    }

    const pkgUrl = `http://${localIp}:${fileSrv}/${encodeURIComponent(item.fileName)}`;
    const installUrl = `http://${ps3Ip}:${port}/install.ps3?pkg=${encodeURIComponent(pkgUrl)}`;

    try {
      await httpGet(installUrl, 20000);
    } catch (e) {
      // Try fallback endpoint
      try {
        const fallback = `http://${ps3Ip}:${port}/install.ps3mapi?syscall=8&param1=${encodeURIComponent(pkgUrl)}`;
        await httpGet(fallback, 20000);
      } catch {}
    }

    // Poll progress
    let lastPct = 0;
    for (let attempt = 0; attempt < 600; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const { body } = await httpGet(`http://${ps3Ip}:${port}/progress.ps3`, 5000);
        let pct = 0;
        const m = body.match(/(\d+(\.\d+)?)\s*%/);
        if (m) pct = parseFloat(m[1]);
        else {
          const n = parseFloat(body.trim());
          if (!isNaN(n)) pct = n;
        }
        if (pct !== lastPct) {
          lastPct = pct;
          sender.send('install-progress', {
            idx, total: items.length, file: item.fileName, status: 'installing', percent: pct
          });
        }
        if (pct >= 100) break;
      } catch {
        // progress endpoint may not be available; wait and assume done after a while
        if (attempt > 60) break;
      }
    }

    sender.send('install-progress', {
      idx, total: items.length, file: item.fileName, status: 'done', percent: 100
    });
  }

  sender.send('install-progress', { status: 'all-done', total: items.length });
}

// ─── GO: copy/move with progress ──────────────────────────────────────────────
async function goPkgs(items, destDir, action, layout, fmt, ftpDestCfg, sender) {
  const ac = new AbortController();
  currentAbortController = ac;

  const total = items.length;
  let done  = 0;

  for (const item of items) {
    if (ac.signal.aborted) break;
    const dest = buildDestPath(item, destDir, layout, fmt);

    sender.send('go-progress', {
      type: 'file-start', file: item.fileName, dest, done, total
    });

    try {
      if (item.isFtp && ftpDestCfg) {
        // FTP → FTP
        sender.send('go-progress', { type: 'file-done', file: item.fileName, done: ++done, total });
      } else if (item.isFtp) {
        // FTP → Local
        const { Client } = require('basic-ftp');
        const client = new Client();
        await client.access({
          host: item.ftpCfg.host, port: item.ftpCfg.port || 21,
          user: item.ftpCfg.user || 'anonymous', password: item.ftpCfg.pass || ''
        });
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await client.downloadTo(dest, item.filePath);
        client.close();
        sender.send('go-progress', { type: 'file-done', file: item.fileName, done: ++done, total });
      } else if (ftpDestCfg) {
        // Local → FTP
        const { Client } = require('basic-ftp');
        const client = new Client();
        await client.access({
          host: ftpDestCfg.host, port: ftpDestCfg.port || 21,
          user: ftpDestCfg.user || 'anonymous', password: ftpDestCfg.pass || ''
        });
        const remDest = dest.replace(/\\/g, '/');
        await client.uploadFrom(item.filePath, remDest);
        client.close();
        sender.send('go-progress', { type: 'file-done', file: item.fileName, done: ++done, total });
      } else {
        // Local → Local
        const progressCb = (transferred, fileTotal) => {
          sender.send('go-progress', {
            type: 'file-progress', file: item.fileName, transferred, fileTotal, done, total
          });
        };
        const cancelCheck = () => ac.signal.aborted;
        if (action === 'move') {
          await moveFileWithProgress(item.filePath, dest, progressCb, cancelCheck);
        } else {
          await copyFileWithProgress(item.filePath, dest, progressCb, cancelCheck);
        }
        done++;
        sender.send('go-progress', { type: 'file-done', file: item.fileName, done, total });
      }
    } catch (e) {
      sender.send('go-progress', { type: 'file-error', file: item.fileName, error: e.message, done: ++done, total });
    }
  }

  sender.send('go-progress', { type: 'all-done', done, total, cancelled: ac.signal.aborted });
}

// ─── IPC setup ────────────────────────────────────────────────────────────────
let currentAbortController = null;

function setupIpc() {
  ipcMain.handle('open-directory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('show-in-folder', async (_e, p) => {
    try {
      shell.showItemInFolder(p);
    } catch {
      shell.openPath(path.dirname(p));
    }
  });

  ipcMain.handle('open-external', async (_e, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return;
    await shell.openExternal(url);
  });

  ipcMain.handle('clipboard-write', (_e, text) => {
    clipboard.writeText(String(text));
  });

  ipcMain.handle('get-all-drives', async () => {
    return getAllDrives();
  });

  ipcMain.handle('get-local-ip', () => getLocalIp());

  ipcMain.handle('scan-pkgs', async (event, sourceDir) => {
    return scanPkgs(sourceDir, event.sender);
  });

  ipcMain.handle('cancel-operation', () => {
    if (currentAbortController) currentAbortController.abort();
  });

  ipcMain.handle('ftp-scan-pkgs', async (event, cfg) => {
    return scanPkgsFtp(cfg, event.sender);
  });

  ipcMain.handle('ftp-test-conn', async (_e, cfg) => {
    const { Client } = require('basic-ftp');
    const client = new Client();
    try {
      await client.access({
        host: cfg.host, port: cfg.port || 21,
        user: cfg.user || 'anonymous', password: cfg.pass || '',
        secure: false,
      });
      const list = await client.list('/');
      client.close();
      return { ok: true, entries: list.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('delete-pkgs', async (_e, items) => {
    const errors = [];
    for (const item of items) {
      if (item.isFtp) {
        const { Client } = require('basic-ftp');
        const client = new Client();
        try {
          await client.access({
            host: item.ftpCfg.host, port: item.ftpCfg.port || 21,
            user: item.ftpCfg.user || 'anonymous', password: item.ftpCfg.pass || ''
          });
          await client.remove(item.filePath);
          client.close();
        } catch (e) {
          errors.push({ file: item.fileName, error: e.message });
        }
      } else {
        try {
          await fs.promises.unlink(item.filePath);
        } catch (e) {
          errors.push({ file: item.fileName, error: e.message });
        }
      }
    }
    return { ok: errors.length === 0, errors };
  });

  ipcMain.handle('rename-pkg', async (_e, item, newName) => {
    const safe = sanitize(newName);
    if (!safe) return { ok: false, error: 'Invalid name' };
    const dir     = path.dirname(item.filePath);
    const newPath = path.join(dir, safe.endsWith('.pkg') ? safe : safe + '.pkg');
    try {
      guardPath(dir, newPath);
      await fs.promises.rename(item.filePath, newPath);
      return { ok: true, newPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('check-pkg-conflicts', async (_e, items, destDir, layout, fmt) => {
    const conflicts = [];
    for (const item of items) {
      const dest = buildDestPath(item, destDir, layout, fmt);
      try {
        await fs.promises.access(dest);
        conflicts.push({ src: item.filePath, dest });
      } catch {}
    }
    return conflicts;
  });

  ipcMain.handle('go-pkgs', async (event, items, destDir, action, layout, fmt, ftpDestCfg) => {
    return goPkgs(items, destDir, action, layout, fmt, ftpDestCfg, event.sender);
  });

  ipcMain.handle('remote-install', async (event, items, ps3Ip, ps3Port, srvPort) => {
    return remoteInstall(items, ps3Ip, ps3Port, srvPort, event.sender);
  });

  ipcMain.handle('stop-pkg-server', () => stopPkgServer());
}

// ─── Window creation ──────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width:           1380,
    height:          860,
    show:            false,
    icon:            path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload:            path.join(__dirname, 'preload.js'),
      contextIsolation:   true,
      nodeIntegration:    false,
      devTools:           !app.isPackaged,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.maximize();
  mainWindow.show();

  // Block DevTools, reload shortcuts
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { _e.preventDefault(); return; }
    if (input.key === 'F5')  { _e.preventDefault(); return; }
    if ((input.control || input.meta) && input.shift && input.key === 'I') { _e.preventDefault(); return; }
    if ((input.control || input.meta) && input.key === 'r') { _e.preventDefault(); return; }
    if ((input.control || input.meta) && input.key === 'R') { _e.preventDefault(); return; }
  });
}

app.whenReady().then(() => {
  setupIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPkgServer();
  if (process.platform !== 'darwin') app.quit();
});
