import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !fs.existsSync(eventPath)) {
  console.error('GITHUB_EVENT_PATH missing');
  process.exit(1);
}
const evt = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const issue = evt.issue;
const body = issue.body || '';

// Helpers
function between(label) {
  // Matches Issue Forms style: "### Label" then content until next heading
  const re = new RegExp(`###\s+${label}\s*\n([\s\S]*?)(?=\n###|$)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}
function extractImageUrls() {
  const urls = [];
  const re = /(https:\/\/user-images\.githubusercontent\.com\/[\w\-\/.%?=&+#]+)/g;
  let m; while ((m = re.exec(body)) !== null) urls.push(m[1]);
  return Array.from(new Set(urls));
}
function safeId(str) { return (str || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }

const identifier = between('Personal identifier') || between('Identifier');
const glaze = between('Glaze');
const clay = between('Clay body');
const notes = between('Notes');
const tagsCsv = between('Tags');
const tags = tagsCsv ? tagsCsv.split(',').map(s=>s.trim()).filter(Boolean) : [];
const imgs = extractImageUrls();

if (!identifier || imgs.length === 0) {
  console.log('No identifier or images found; nothing to do.');
  process.exit(0);
}

// Ensure folders
fs.mkdirSync('images', { recursive: true });
fs.mkdirSync('data', { recursive: true });
if (!fs.existsSync('data/items.json')) fs.writeFileSync('data/items.json','[]');

// Download first image (feature). Keep remote filename extension if possible.
const featureUrl = imgs[0];
const urlExt = new URL(featureUrl).pathname.split('.').pop().toLowerCase();
const ext = ['jpg','jpeg','png','webp','gif','avif'].includes(urlExt) ? `.${urlExt}` : '.jpg';
const idBase = safeId(identifier) || crypto.randomBytes(6).toString('hex');
const fileName = `${idBase}-${crypto.randomBytes(3).toString('hex')}${ext}`;
const localPath = path.join('images', fileName);

console.log(`Downloading ${featureUrl} -> ${localPath}`);
const res = await fetch(featureUrl);
if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(localPath, buf);

// Load & update JSON
const items = JSON.parse(fs.readFileSync('data/items.json','utf8'));
const record = {
  id: crypto.randomUUID(),
  identifier,
  glaze,
  clay_body: clay,
  notes,
  tags,
  image_url: localPath.replace(/\\/g,'/'),
  submitted_at: new Date().toISOString(),
  source_issue: issue.number
};
items.push(record);
fs.writeFileSync('data/items.json', JSON.stringify(items, null, 2));

console.log('Added record to data/items.json');
