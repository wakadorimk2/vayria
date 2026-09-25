#!/usr/bin/env node
// Extracts VLM bench fixtures from Steam Game Recording sessions.
// Steam stores recordings as DASH fragments (init-*.m4s + chunk-*.m4s +
// session.mpd). Each fixture is a SHORT sequence of frames covering one
// ~3 s window — one Steam chunk — so that short events (enemy appears,
// menu opens, hit flash) survive inside the sequence instead of being
// flattened into a distant before/after pair.
//
// For every recording chunk the script pipes init + chunk to ffmpeg and
// emits `--frames` evenly spaced JPEGs. Windows are scored by the pixel
// difference between the first and last frame; high-scoring windows become
// active fixtures, near-static ones become negative fixtures.
//
// Usage:
//   node scripts/extract-stream-fixtures.mjs [--recordings-root <dir>]
//     [--window 3] [--frames 5] [--cap 120] [--negatives 15]
//     [--session <name>] [--dry-run]
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const DEFAULT_RECORDINGS_ROOT =
  'C:/Program Files (x86)/Steam/userdata/108943716/gamerecordings/video';
const APP_ID = '251570';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const recordingsRoot = argValue('recordings-root', DEFAULT_RECORDINGS_ROOT);
const windowSec = Math.max(3, Number(argValue('window', '3')) || 3);
const framesPerWindow = Math.max(2, Number(argValue('frames', '5')) || 5);
const cap = Math.max(1, Number(argValue('cap', '120')) || 120);
const negatives = Math.max(0, Number(argValue('negatives', '15')) || 15);
const sessionFilter = argValue('session', '');
const outRoot = resolve(argValue('out', 'stream-bench/fixtures'));
const workRoot = resolve('stream-bench/.work');
const dryRun = args.includes('--dry-run');
const staticThreshold = Number(argValue('static-threshold', '0.03'));

function sessions() {
  if (!existsSync(recordingsRoot)) return [];
  return readdirSync(recordingsRoot)
    .filter(
      (name) =>
        name.startsWith(`bg_${APP_ID}_`) &&
        existsSync(join(recordingsRoot, name, 'session.mpd')),
    )
    .filter((name) => !sessionFilter || name.includes(sessionFilter))
    .sort();
}

function sessionDurationSeconds(dir) {
  const mpd = readFileSync(join(dir, 'session.mpd'), 'utf8');
  const match = mpd.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/);
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

function sessionChunks(sessionDir) {
  return readdirSync(sessionDir)
    .filter((name) => /^chunk-stream0-\d+\.m4s$/.test(name))
    .sort();
}

// ffmpeg's DASH demuxer drops sessions whose SegmentTemplate startNumber
// does not begin at 1 (resumed Steam recordings). Streaming init + chunk
// bytes through stdin as a single fMP4 works for every session.
// Each 3 s chunk starts with a keyframe (SAP), so a window needs only its
// own chunks decoded instead of the whole recording.
const CHUNK_SECONDS = 3;
const EXTRACT_CONCURRENCY = 6;

async function extractWindow(sessionDir, chunkNames, windowDir) {
  mkdirSync(windowDir, { recursive: true });
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'mp4',
      '-i', 'pipe:0',
      '-vf', `fps=${framesPerWindow / (chunkNames.length * CHUNK_SECONDS)},scale=768:-2`,
      '-q:v', '4',
      join(windowDir, 'f%d.jpg'),
      '-y',
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  );
  const finished = new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`ffmpeg exited ${code}`)),
    );
  });
  let done = false;
  void finished.then(() => { done = true; }, () => { done = true; });
  child.stdin.on('error', () => {});
  for (const file of ['init-stream0.m4s', ...chunkNames]) {
    if (done) break;
    const data = readFileSync(join(sessionDir, file));
    if (!child.stdin.write(data)) {
      await Promise.race([
        new Promise((resolvePromise) => child.stdin.once('drain', resolvePromise)),
        finished.catch(() => {}),
      ]);
    }
  }
  child.stdin.destroy();
  await finished;
  return readdirSync(windowDir)
    .filter((name) => /^f\d+\.jpg$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

async function extractSessionWindows(sessionDir, windowsDir) {
  rmSync(windowsDir, { recursive: true, force: true });
  mkdirSync(windowsDir, { recursive: true });
  const chunks = sessionChunks(sessionDir);
  const chunksPerWindow = Math.max(1, Math.ceil(windowSec / CHUNK_SECONDS));
  const tasks = [];
  for (let i = 0; i + chunksPerWindow <= chunks.length; i += chunksPerWindow) {
    tasks.push({
      windowIndex: i / chunksPerWindow,
      startChunk: i,
      chunkNames: chunks.slice(i, i + chunksPerWindow),
    });
  }
  let cursor = 0;
  let produced = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      const windowDir = join(
        windowsDir,
        `w${String(task.windowIndex).padStart(5, '0')}`,
      );
      try {
        const frames = await extractWindow(sessionDir, task.chunkNames, windowDir);
        if (frames.length < 2) {
          rmSync(windowDir, { recursive: true, force: true });
          continue;
        }
        produced += 1;
        if (produced % 100 === 0) {
          process.stdout.write(`\r  ${produced}/${tasks.length} windows`);
        }
      } catch (error) {
        rmSync(windowDir, { recursive: true, force: true });
        console.warn(
          `  window ${task.windowIndex} skipped: ${error.message}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: EXTRACT_CONCURRENCY }, () => worker()),
  );
  if (produced) process.stdout.write('\n');
  return readdirSync(windowsDir)
    .filter((name) => /^w\d{5}$/.test(name))
    .sort();
}

// A single time-ordered strip for VLM input: 512px tiles, each labeled
// "F<n> <t>s". Matches server/stream/contactSheet.ts.
const TILE_WIDTH = 512;
const TILE_HEIGHT = 288;

function labelSvg(text) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_WIDTH}" height="28">` +
      `<rect width="${TILE_WIDTH}" height="28" fill="#10151d"/>` +
      `<text x="10" y="19" font-family="sans-serif" font-size="15" fill="#dbe4f0">${text}</text>` +
      '</svg>',
  );
}

async function buildSheet(framePaths, spacingSec, outPath) {
  const tiles = await Promise.all(
    framePaths.map(async (path, index) => {
      const tile = await sharp(path)
        .resize(TILE_WIDTH, TILE_HEIGHT, { fit: 'fill' })
        .composite([
          {
            input: labelSvg(`F${index + 1}  ${(index * spacingSec).toFixed(1)}s`),
            top: 0,
            left: 0,
          },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
      return { input: tile, left: index * TILE_WIDTH, top: 0 };
    }),
  );
  const sheet = await sharp({
    create: {
      width: TILE_WIDTH * framePaths.length,
      height: TILE_HEIGHT,
      channels: 3,
      background: '#000000',
    },
  })
    .composite(tiles)
    .jpeg({ quality: 82 })
    .toBuffer();
  writeFileSync(outPath, sheet);
}

async function diffScore(aPath, bPath) {
  const size = { width: 96, height: 54, fit: 'fill' };
  const [a, b] = await Promise.all([
    sharp(aPath).resize(size).grayscale().raw().toBuffer(),
    sharp(bPath).resize(size).grayscale().raw().toBuffer(),
  ]);
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 255);
}

async function scoreSession(session) {
  const sessionDir = join(recordingsRoot, session);
  const windowsDir = join(workRoot, session);
  const windows = await extractSessionWindows(sessionDir, windowsDir);
  const chunksPerWindow = Math.max(1, Math.ceil(windowSec / CHUNK_SECONDS));
  const pairs = [];
  for (const windowName of windows) {
    const windowDir = join(windowsDir, windowName);
    const frames = readdirSync(windowDir)
      .filter((name) => /^f\d+\.jpg$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (frames.length < 2) continue;
    const windowIndex = Number(windowName.slice(1));
    const startSec = windowIndex * chunksPerWindow * CHUNK_SECONDS;
    const score = await diffScore(
      join(windowDir, frames[0]),
      join(windowDir, frames[frames.length - 1]),
    );
    pairs.push({
      session,
      windowDir,
      frames: frames.map((name) => join(windowDir, name)),
      startSec,
      endSec: startSec + chunksPerWindow * CHUNK_SECONDS,
      diffScore: score,
    });
  }
  return pairs;
}

function pickEvenly(list, count) {
  if (list.length <= count) return list;
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step)]);
}

async function main() {
  const sessionList = sessions();
  if (sessionList.length === 0) {
    console.error(`No ${APP_ID} sessions found under ${recordingsRoot}`);
    process.exit(1);
  }
  console.log(`Sessions: ${sessionList.join(', ')}`);
  const allPairs = [];
  for (const session of sessionList) {
    const duration = sessionDurationSeconds(join(recordingsRoot, session));
    console.log(`\nExtracting ${session} (~${Math.round((duration ?? 0) / 60)} min)...`);
    const pairs = await scoreSession(session);
    console.log(`  ${pairs.length} windows scored`);
    allPairs.push(...pairs);
  }
  const scores = allPairs.map((p) => p.diffScore).sort((a, b) => a - b);
  const quantile = (q) => scores[Math.floor(q * (scores.length - 1))];
  console.log(
    `\n${allPairs.length} candidate windows. diffScore p10=${quantile(0.1)?.toFixed(3)} p50=${quantile(0.5)?.toFixed(3)} p90=${quantile(0.9)?.toFixed(3)}`,
  );

  const staticPool = allPairs.filter((p) => p.diffScore < staticThreshold);
  const activePool = allPairs.filter((p) => p.diffScore >= staticThreshold);
  const selectedStatic = pickEvenly(staticPool, negatives);
  const selectedActive = pickEvenly(activePool, Math.max(0, cap - selectedStatic.length));
  const selected = [...selectedActive, ...selectedStatic];

  console.log(
    `Selecting ${selectedActive.length} active + ${selectedStatic.length} static windows -> ${outRoot}`,
  );
  if (dryRun) {
    for (const pair of selected) {
      console.log(
        `  ${pair.session} t=${pair.startSec}-${pair.endSec}s score=${pair.diffScore.toFixed(3)}`,
      );
    }
    return;
  }

  // Replace previously auto-generated fixtures; keep hand-made directories.
  if (existsSync(outRoot)) {
    for (const entry of readdirSync(outRoot)) {
      if (entry.startsWith('auto-')) {
        rmSync(join(outRoot, entry), { recursive: true, force: true });
      }
    }
  }
  mkdirSync(outRoot, { recursive: true });

  for (const pair of selected) {
    const stamp = pair.session.replace(/^bg_\d+_/, '');
    const id = `auto-${stamp}-t${String(pair.startSec).padStart(5, '0')}`;
    const dir = join(outRoot, id);
    mkdirSync(dir, { recursive: true });
    cpSync(pair.frames[0], join(dir, 'before.jpg'));
    cpSync(pair.frames[pair.frames.length - 1], join(dir, 'after.jpg'));
    for (let i = 1; i < pair.frames.length - 1; i += 1) {
      cpSync(pair.frames[i], join(dir, `mid-${i}.jpg`));
    }
    const spacingSec =
      (pair.endSec - pair.startSec) / pair.frames.length;
    await buildSheet(
      pair.frames,
      spacingSec,
      join(dir, 'contact-sheet.jpg'),
    );
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify(
        {
          category: 'auto',
          expectedChanged:
            pair.diffScore < staticThreshold ? false : null,
          expectedEventKinds: [],
          notes: 'Auto-extracted from Steam recording. Review thumbnails and label.',
          source: {
            session: pair.session,
            beforeSec: pair.startSec,
            afterSec: pair.endSec,
            windowSec: pair.endSec - pair.startSec,
            frameCount: pair.frames.length,
            diffScore: Number(pair.diffScore.toFixed(4)),
          },
        },
        null,
        2,
      ),
    );
  }
  console.log(`Wrote ${selected.length} fixtures. Cleaning ${workRoot}`);
  rmSync(workRoot, { recursive: true, force: true });
}

await main();
