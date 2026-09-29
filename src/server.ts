import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Status = 'unknown' | 'up' | 'down';
type Site = { id: number; name: string; url: string; status: Status; lastChecked: string | null; lastHttpStatus: number | null; lastError: string | null };
type Event = { id: number; siteId: number; status: 'up' | 'down'; detail: string; createdAt: string };
type Data = { sites: Site[]; events: Event[] };
const app = express();
app.use(express.json({ limit: '16kb' }));
const dataFile = resolve(process.env.DATA_FILE || './data/sites.json');
const apiKey = process.env.API_KEY || '';
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const intervalSeconds = Math.max(30, Number(process.env.CHECK_INTERVAL_SECONDS) || 60);
const port = Number(process.env.PORT) || 3335;
let demoDown = false;
let checking = false;

function readData(): Data {
  try { return JSON.parse(readFileSync(dataFile, 'utf8')) as Data; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sites: [], events: [] };
    throw error;
  }
}
function saveData(data: Data): void {
  mkdirSync(dirname(dataFile), { recursive: true });
  const temp = `${dataFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, dataFile);
}
function auth(req: Request, res: Response, next: NextFunction): void {
  if (!apiKey || req.header('x-api-key') !== apiKey) {
    res.status(401).json({ error: 'Chave de API inválida' }); return;
  }
  next();
}

async function telegram(message: string): Promise<void> {
  if (!token || !chatId) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) console.error('Telegram notification failed:', response.status);
  } catch (error) { console.error('Telegram notification failed:', (error as Error).name); }
}
async function checkSite(id: number) {
  const snapshot = readData().sites.find(site => site.id === id);
  if (!snapshot) return null;
  let code: number | null = null;
  let error: string | null = null;
  let status: 'up' | 'down' = 'down';
  try {
    const response = await fetch(snapshot.url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    code = response.status;
    await response.body?.cancel();
    status = code < 400 ? 'up' : 'down';
  } catch (caught) { error = (caught as Error).name; }
  const detail = code === null ? error || 'Erro de rede' : `HTTP ${code}`;
  const date = new Date().toISOString();
  const data = readData();
  const current = data.sites.find(site => site.id === id);
  if (!current) return null;
  const changed = current.status !== 'unknown' && current.status !== status;
  Object.assign(current, { status, lastChecked: date, lastHttpStatus: code, lastError: error });
  if (changed) data.events.unshift({ id: (data.events[0]?.id || 0) + 1, siteId: id, status, detail, createdAt: date });
  data.events = data.events.slice(0, 100);
  saveData(data);
  if (changed) await telegram(`${status === 'down' ? 'CAIU' : 'VOLTOU'}: ${current.name}\n${current.url}\n${detail}\n${date}`);
  return { id, status, detail, changed };
}
async function checkAll(): Promise<void> {
  if (checking) return;
  checking = true;
  try { for (const site of readData().sites) await checkSite(site.id); }
  catch (error) { console.error('Monitor failed:', error); }
  finally { checking = false; }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/demo-target', (_req, res) => res.status(demoDown ? 503 : 200).json({ status: demoDown ? 'down' : 'up' }));
app.use(auth);
app.post('/demo-target/state', (req, res) => {
  if (typeof req.body?.down !== 'boolean') return res.status(400).json({ error: 'Informe {"down": true|false}' });
  demoDown = req.body.down;
  return res.json({ down: demoDown });
});
app.get('/sites', (_req, res) => res.json(readData().sites));
app.post('/sites', (req, res) => {
  const { name, url } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof url !== 'string')
    return res.status(400).json({ error: 'Nome e URL são obrigatórios' });
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
      throw new Error('invalid');
  } catch { return res.status(400).json({ error: 'URL http(s) inválida' }); }
  const data = readData();
  if (data.sites.some(site => site.url === url)) return res.status(409).json({ error: 'URL já cadastrada' });
  const site: Site = {
    id: Math.max(0, ...data.sites.map(item => item.id)) + 1, name: name.trim(), url,
    status: 'unknown', lastChecked: null, lastHttpStatus: null, lastError: null
  };
  data.sites.push(site);
  saveData(data);
  return res.status(201).json(site);
});
app.delete('/sites/:id', (req, res) => {
  const data = readData();
  const index = data.sites.findIndex(site => site.id === Number(req.params.id));
  if (index < 0) return res.status(404).json({ error: 'Site não encontrado' });
  data.sites.splice(index, 1);
  saveData(data);
  return res.sendStatus(204);
});
app.post('/sites/:id/check', async (req, res) => {
  const result = await checkSite(Number(req.params.id));
  return result ? res.json(result) : res.status(404).json({ error: 'Site não encontrado' });
});
app.get('/events', (_req, res) => res.json(readData().events));
app.listen(port, '127.0.0.1', () => {
  console.log(`Monitor ouvindo em http://127.0.0.1:${port}`);
  setInterval(() => { void checkAll(); }, intervalSeconds * 1000);
  void checkAll();
});
