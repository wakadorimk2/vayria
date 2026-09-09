// Explicit, opt-in live API check. Each step spends one image attempt; no retries.
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialWorld } from '../node_modules/.tmp/world-test/src/world/worldState.js';

const origin = process.argv[2] ?? 'https://localhost:5201';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local API only');
const output = process.argv[3] ? resolve(process.argv[3]) : resolve('.world-experiments', `freshness-${Date.now()}`);
mkdirSync(output, { recursive: true });
const post = (path, value) => new Promise((resolveResult, reject) => {
  const req = request(new URL(path, origin), { method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', Origin: origin } }, res => {
    let data = '';
    res.setEncoding('utf8'); res.on('data', part => { data += part; });
    res.on('end', () => {
      try { const parsed = JSON.parse(data); if (res.statusCode !== 200) reject(new Error(`${res.statusCode}: ${parsed.error}`)); else resolveResult(parsed); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject); req.end(JSON.stringify(value));
});
const manifest = resolve(output, 'experiment.json');
const { experimentId } = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : await post('/api/world/experiments', {});
writeFileSync(manifest, JSON.stringify({ experimentId }));
let world = initialWorld();
const brain = ['tiny', 'curious', 'secret', 'sleepy', 'rain'];
const cardInsertedAt = {};
console.log(JSON.stringify({ output, experimentId }));
for (const [index, cardId] of ['underwater', 'chicken', 'gigantic', 'sparkle'].entries()) {
  brain[index] = cardId; cardInsertedAt[cardId] = Date.now();
  const saved = resolve(output, `${index + 1}-${cardId}.json`);
  if (existsSync(saved)) {
    const completed = JSON.parse(readFileSync(saved, 'utf8'));
    world = completed.world; cardInsertedAt[cardId] = completed.timing.receivedAt;
    console.log(`Using completed image ${index + 1}: ${cardId}`); continue;
  }
  console.log(`Generating ${index + 1}: ${cardId}`);
  const result = await post('/api/world/mutate', { experimentId, sessionGeneration: 0, eventId: randomUUID(), source: 'card', cardId, brainCardIds: [...brain], cardInsertedAt: { ...cardInsertedAt }, world });
  if (!result.media) throw new Error('Image missing');
  world = result.world;
  writeFileSync(resolve(output, `${index + 1}-${cardId}.png`), Buffer.from(result.media.url.split(',')[1], 'base64'));
  writeFileSync(resolve(output, `${index + 1}-${cardId}.json`), JSON.stringify({ ...result, media: { kind: 'image', url: `${index + 1}-${cardId}.png` } }, null, 2));
  console.log(JSON.stringify({ cardId, attempts: result.attempts, timing: result.timing, observation: result.observation.available, scene: world.sceneElements.map(e => ({ id: e.id, stage: e.stage })) }));
}
// Keep actual wall-clock age. This is a fifth explicit card input, not a decay timer generation.
const wait = Math.max(0, cardInsertedAt.gigantic + 210000 - Date.now());
console.log(`Waiting ${Math.round(wait / 1000)} seconds before another card`);
await new Promise(resolveWait => setTimeout(resolveWait, wait));
brain[4] = 'secret'; cardInsertedAt.secret = Date.now();
const last = await post('/api/world/mutate', { experimentId, sessionGeneration: 0, eventId: randomUUID(), source: 'card', cardId: 'secret', brainCardIds: brain, cardInsertedAt, world });
writeFileSync(resolve(output, '5-after-wait.png'), Buffer.from(last.media.url.split(',')[1], 'base64'));
writeFileSync(resolve(output, '5-after-wait.json'), JSON.stringify({ ...last, media: { kind: 'image', url: '5-after-wait.png' } }, null, 2));
console.log(JSON.stringify({ output, attempts: last.attempts, observation: last.observation.available, scene: last.world.sceneElements.map(e => ({ id: e.id, stage: e.stage })) }));
