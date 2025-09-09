// ---------- Firebase imports ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, setLogLevel } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
// Optional App Check (uncomment + add your site key, then enforce in console)
// import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";
import { firebaseConfig } from "./firebase-config.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";


// ---------- Capacity & image settings (tuned for ≤ 3k pieces under 5GB) ----------
const MAX_LIBRARY_BYTES = 5e9;          // 5 GB (decimal)
const EXPECTED_MAX_SUBMISSIONS = 3000;  // you said ≤ 3k
const SAFETY = 0.85;                    // 15% headroom

const PER_SUBMISSION_BUDGET = Math.floor(MAX_LIBRARY_BYTES * SAFETY / EXPECTED_MAX_SUBMISSIONS);
// Allocate 90% to main image, 10% to thumbnail
const MAIN_BUDGET_BYTES  = Math.floor(PER_SUBMISSION_BUDGET * 0.90);
const THUMB_BUDGET_BYTES = PER_SUBMISSION_BUDGET - MAIN_BUDGET_BYTES;

// Visual max dimensions
const IMAGE_MAX_LONG_EDGE = 1600; // px
const THUMB_MAX_LONG_EDGE = 480;  // px


// Helper file name
function slugPart(s) {
  return (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')                      // keep a–z, 0–9, hyphen
    .replace(/^-+|-+$/g, '');                          // trim hyphens
}

// ---------- Helpers: image loading & compression ----------
async function fileToImageBitmap(file) {
  if ('createImageBitmap' in window) {
    return await createImageBitmap(file, { imageOrientation: 'from-image' }); // respects EXIF
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  return img;
}

async function encodeCanvas(canvas, type, quality) {
  if ('convertToBlob' in canvas) {
    return await canvas.convertToBlob({ type, quality });
  }
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), type, quality);
  });
}

/**
 * Resize and compress to a target byte budget using binary search on quality.
 * Chooses WebP if encoder supported, else JPEG.
 * Returns { file, blob, width, height, type }
 */
async function resizeToBudget(file, {
  maxWidth = 1280,
  maxHeight = 1280,
  targetBytes = 200 * 1024,
  preferType = 'image/webp',
  fallbackType = 'image/jpeg',
  qMin = 0.55,
  qMax = 0.88
} = {}) {
  const src = await fileToImageBitmap(file);
  const sw = src.width, sh = src.height;

  // Compute destination size (no upscaling)
  let dw = sw, dh = sh;
  if (sw > maxWidth || sh > maxHeight) {
    const r = Math.min(maxWidth / sw, maxHeight / sh);
    dw = Math.round(sw * r);
    dh = Math.round(sh * r);
  }

  const canvas = ('OffscreenCanvas' in window)
    ? new OffscreenCanvas(dw, dh)
    : Object.assign(document.createElement('canvas'), { width: dw, height: dh });
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, dw, dh);

  async function tryType(type) {
    let lo = qMin, hi = qMax, best = null;
    for (let i = 0; i < 6; i++) {
      const q = (lo + hi) / 2;
      let blob;
      try { blob = await encodeCanvas(canvas, type, q); } catch { return null; }
      if (!blob) return null;

      if (blob.size <= targetBytes) {
        best = { blob, q }; // fits; try higher quality
        lo = q;
      } else {
        hi = q;             // too big; lower quality
      }
    }
    if (!best) {
      const minBlob = await encodeCanvas(canvas, type, qMin);
      best = { blob: minBlob, q: qMin };
    }
    return best;
  }

  // Prefer WebP, then fall back
  let type = preferType;
  let out = await tryType(type);
  if (!out) { type = fallbackType; out = await tryType(type); }

  const base = (file.name || 'image').replace(/\.[^.]+$/, '');
  const ext  = type === 'image/webp' ? 'webp' : 'jpg';
  const named = new File([out.blob], `${base}.${ext}`, { type });

  return { file: named, blob: out.blob, width: dw, height: dh, type };
}

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
// Optional App Check
// initializeAppCheck(app, { provider: new ReCaptchaV3Provider("YOUR_RECAPTCHA_SITE_KEY"), isTokenAutoRefreshEnabled: true });

const auth = getAuth(app);
const db = getFirestore(app);
// setLogLevel('debug'); // temporary while debugging
const storage = getStorage(app);
const functions = getFunctions(app);
const submitSuggestionFn = httpsCallable(functions, "submitSuggestion");


// Anonymous auth (required for Storage write & Firestore create per your rules)
signInAnonymously(auth).catch(console.error);

// ---------- UI hooks ----------
const modal = document.getElementById('detail-modal');
document.getElementById('modal-close')?.addEventListener('click', ()=> modal.close());
modal?.addEventListener('click', (e)=>{ if (e.target === modal) modal.close(); });

const submitModal = document.getElementById('submit-modal');
document.getElementById('open-submit')?.addEventListener('click', ()=> submitModal?.showModal?.());
document.getElementById('submit-close')?.addEventListener('click', ()=> submitModal?.close?.());
submitModal?.addEventListener('click', (e)=>{ if (e.target === submitModal) submitModal.close(); });

const form = document.getElementById('submit-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('submit-status');

// ---------- Clay body: White / Red / Other (+ text) ----------
const clayChoice = document.getElementById('clay_body_choice');


// ---------- Glaze repeater (name, layers, application) ----------
const glazesWrap = document.getElementById('glazes');
const addGlazeBtn = document.getElementById('add-glaze');

function makeGlazeRow(index, preset = {}) {
  const row = document.createElement('div');
  row.className = 'glaze-row';
  row.dataset.index = index;

  row.innerHTML = `
    <label>Glaze
      <input class="glaze-name" placeholder="e.g., Obsidian" required value="${preset.name ?? ''}">
    </label>
    <label class="layers">Layers
      <div class="layers-input">
        <input class="glaze-layers" type="number" min="1" max="5" step="1" value="${preset.layers ?? 2}" required>
      </div>
    </label>
    <label>Application (optional)
      <input class="glaze-application" placeholder="e.g., top half" value="${preset.application ?? ''}">
    </label>
    <button type="button" class="btn remove-glaze" aria-label="Remove glaze">Remove</button>
  `;

  row.querySelector('.remove-glaze').addEventListener('click', () => {
    const rows = glazesWrap.querySelectorAll('.glaze-row');
    if (rows.length > 1) row.remove(); // always keep at least one row
  });

  return row;
}

// Ensure at least one row exists on load
(function ensureOneGlazeRow(){
  if (!glazesWrap) return;
  const rows = glazesWrap.querySelectorAll('.glaze-row');
  if (rows.length === 0 && addGlazeBtn) {
    glazesWrap.insertBefore(makeGlazeRow(0), addGlazeBtn.parentElement);
  }
})();

// Add row on click
addGlazeBtn?.addEventListener('click', () => {
  const nextIndex = glazesWrap.querySelectorAll('.glaze-row').length;
  glazesWrap.insertBefore(makeGlazeRow(nextIndex), addGlazeBtn.parentElement);
});


// Suggestions
const suggestModal  = document.getElementById('suggest-modal');
document.getElementById('open-suggest')?.addEventListener('click', ()=> suggestModal?.showModal?.());
document.getElementById('suggest-close')?.addEventListener('click', ()=> suggestModal?.close?.());
document.getElementById('suggest-cancel')?.addEventListener('click', ()=> suggestModal?.close?.());

const suggestForm   = document.getElementById('suggest-form');
const suggestBtn    = document.getElementById('suggest-submit');
const suggestStatus = document.getElementById('suggest-status');

suggestForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = document.getElementById('suggest-text').value.trim();
  if (!text) { suggestStatus.textContent = 'Please type a suggestion.'; return; }

  suggestBtn.disabled = true;
  suggestStatus.textContent = 'Sending...';

  try {
    // Optionally include some context from the current form if it exists
    const identifier = (document.querySelector('input[name="identifier"]')?.value || '').trim();
    const clay_body = (document.getElementById('clay_body_choice')?.value || '').toString();

    // Collect glaze names if your repeater is on this page
    const glazeRows = Array.from(document.querySelectorAll('.glaze-row'));
    const glaze_names = glazeRows.map(r => r.querySelector('.glaze-name')?.value.trim()).filter(Boolean);

    await submitSuggestionFn({
      text,
      page: location.href,
      identifier: identifier || null,
      clay_body: clay_body || null,
      glazes: glaze_names
    });

    suggestStatus.textContent = 'Thanks, suggestion has been added!';
    suggestForm.reset();
    setTimeout(()=> { suggestModal?.close?.(); suggestStatus.textContent = ''; }, 900);
  } catch (err) {
    console.error(err);
    suggestStatus.textContent = `Failed to send: ${err.message || err}`;
  } finally {
    suggestBtn.disabled = false;
  }
});


// ---------- Live gallery (Firestore) ----------
const itemsCol = collection(db, 'items');
const qItems = query(itemsCol, orderBy('submitted_at', 'desc'));

let itemsCache = [];
onSnapshot(qItems, (snap) => {
  itemsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateFilters(itemsCache);
  renderGallery(itemsCache);
}, (err) => {
  console.error(err);
  document.getElementById('gallery').innerHTML = `<p>Failed to load gallery: ${err.message}</p>`;
});

function uniqueSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>a.localeCompare(b));
}

let lastFilterKey = '';
function populateFilters(items) {
  const glazes = uniqueSorted(
    items.flatMap(i => i.glaze_names ?? (i.glaze ? [i.glaze] : []))
  );
  const clays  = uniqueSorted(items.map(i => i.clay_body));
  const key = JSON.stringify([glazes, clays]);
  if (key === lastFilterKey) return;
  lastFilterKey = key;

  const selGlaze = document.getElementById('filter-glaze');
  const selClay  = document.getElementById('filter-clay');
  selGlaze.length = 1; selClay.length = 1;
  for (const g of glazes) selGlaze.insertAdjacentHTML('beforeend', `<option>${g}</option>`);
  for (const c of clays)  selClay.insertAdjacentHTML('beforeend', `<option>${c}</option>`);
}

function renderGallery(items) {
  const g = document.getElementById('filter-glaze').value.trim().toLowerCase();
  const c = document.getElementById('filter-clay').value.trim().toLowerCase();
  const idq = document.getElementById('filter-id').value.trim().toLowerCase();

  const filtered = items.filter(i => {
    const names = i.glaze_names ?? (i.glaze ? [i.glaze] : []);
    const glazeOk = !g || names.some(n => (n || '').toLowerCase() === g);
    const clayOk  = !c || (i.clay_body || '').toLowerCase() === c;
    const idOk    = !idq || (i.identifier || '').toLowerCase().includes(idq);
    return glazeOk && clayOk && idOk;
  });

  const $g = document.getElementById('gallery');
  $g.innerHTML = '';
  for (const item of filtered) {
    const glazeLine = (item.glaze_names && item.glaze_names.length)
      ? item.glaze_names.join(', ')
      : (item.glaze || '');
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" loading="lazy" src="${item.thumb_url || item.image_url}" alt="${item.identifier || 'Pottery'}" />
      <div class="meta">
        <div>
          <div class="title">${[item.clay_body, glazeLine].filter(Boolean).join(' • ')}</div>
        </div>
      </div>
      <button class="open" aria-label="Open details"></button>
    `;
    card.querySelector('button.open').addEventListener('click', () => openDetail(item));
    $g.appendChild(card);
  }
}

function openDetail(item) {
  const elImage = document.getElementById('detail-image');
  const elTitle = document.getElementById('detail-title');
  const elClay = document.getElementById('detail-clay');
  const elGlaze = document.getElementById('detail-glaze');
  const elNotes = document.getElementById('detail-notes');
  const elDate = document.getElementById('detail-date');
  const elIdent = document.getElementById('detail-identifier');

  elImage.src = item.image_url;
  elTitle.textContent = item.identifier || 'Untitled';
  elClay.textContent = item.clay_body || '—';

  const gz = Array.isArray(item.glazes) ? item.glazes : [];
  if (gz.length) {
    const lines = gz.map(g => {
      const parts = [g.name].filter(Boolean);
      if (g.layers) parts.push(`${g.layers} layer${g.layers > 1 ? 's' : ''}`);
      if (g.application) parts.push(g.application);
      return parts.join(' — ');
    });

    elGlaze.replaceChildren(
      ...lines.map(text => {
        const div = document.createElement('div');
        div.textContent = text; // safe, renders as separate lines
        return div;
      })
    );
  } else {
    elGlaze.textContent = item.glaze || '—';
  }

  elNotes.textContent = item.notes || '—';

  const dt = item.submitted_at?.toDate?.() || item.submitted_at;
  elDate.textContent = dt ? new Date(dt).toLocaleString() : '—';

  elIdent.textContent = item.identifier || '—';

  modal.showModal();
}


// Filters -> re-render
document.getElementById('filter-glaze').addEventListener('change',  ()=> renderGallery(itemsCache));
document.getElementById('filter-clay').addEventListener('change',   ()=> renderGallery(itemsCache));
document.getElementById('filter-id').addEventListener('input',      ()=> renderGallery(itemsCache));

// ---------- Submit handler with compression & new fields ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const fd = new FormData(form);
  const identifier = (fd.get('identifier') || '').toString().trim();
  // const tagsCsv    = (fd.get('tags') || '').toString();
  // const tags       = tagsCsv.split(',').map(s => s.trim()).filter(Boolean);
  const notes      = (fd.get('notes') || '').toString();
  const file       = fd.get('image');

  // Clay body (select + optional "Other" text)
  const clayChoiceVal = (fd.get('clay_body_choice') || '').toString();
  const clayOtherVal  = (fd.get('clay_body_other') || '').toString().trim();
  const clay_body     = (clayChoiceVal === 'Other') ? clayOtherVal : clayChoiceVal;

  // Glazes: build from repeater rows
  const glazeRows = Array.from(document.querySelectorAll('.glaze-row'));
  const glazes = glazeRows.map(row => {
    const name = row.querySelector('.glaze-name')?.value.trim() || '';
    const layers = parseInt(row.querySelector('.glaze-layers')?.value, 10) || 1;
    const application = row.querySelector('.glaze-application')?.value.trim() || '';
    return { name, layers, application };
  }).filter(g => g.name);
  const glaze_names = glazes.map(g => g.name);

  const stamp = Date.now();

  // Build: clayBody_glaze1_glaze2_g<COUNT>_<timestamp>
  const clayId   = slugPart(clay_body) || 'na';
  const glazeIds = (glaze_names || []).map(slugPart).filter(Boolean);
  const docIdRaw = [clayId, ...glazeIds, `g${glazeIds.length}`, String(stamp)].join('_');

  // Keep IDs reasonable length (Firestore allows up to 1500 bytes; we’ll cap to 200)
  const docId = docIdRaw.slice(0, 200);

  if (!identifier || !file || !file.size) {
    statusEl.textContent = 'Please provide an identifier and an image.';
    return;
  }
  if (!clay_body) {
    statusEl.textContent = 'Please select a clay body.';
    return;
  }
  if (glazes.length === 0) {
    statusEl.textContent = 'Please add at least one glaze.';
    return;
  }

  submitBtn.disabled = true;
  statusEl.textContent = 'Preparing image...';

  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const uid = auth.currentUser?.uid || 'anon';

    // Compress to target budgets
    const main  = await resizeToBudget(file,  {
      maxWidth: IMAGE_MAX_LONG_EDGE,
      maxHeight: IMAGE_MAX_LONG_EDGE,
      targetBytes: MAIN_BUDGET_BYTES
    });
    const thumb = await resizeToBudget(file,  {
      maxWidth: THUMB_MAX_LONG_EDGE,
      maxHeight: THUMB_MAX_LONG_EDGE,
      targetBytes: THUMB_BUDGET_BYTES
    });

    const baseSlug = identifier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'piece';

    const mainExt  = main.type  === 'image/webp' ? 'webp' : 'jpg';
    const thumbExt = thumb.type === 'image/webp' ? 'webp' : 'jpg';

    const mainRef  = sref(storage, `images/${uid}/${baseSlug}-${stamp}.${mainExt}`);
    const thumbRef = sref(storage, `images/${uid}/thumbs/${baseSlug}-${stamp}.${thumbExt}`);

    statusEl.textContent = 'Uploading...';

    const mainMeta  = { contentType: main.file.type,  cacheControl: 'public, max-age=31536000, immutable' };
    const thumbMeta = { contentType: thumb.file.type, cacheControl: 'public, max-age=31536000, immutable' };

    await uploadBytes(mainRef,  main.file,  mainMeta);
    await uploadBytes(thumbRef, thumb.file, thumbMeta);

    statusEl.textContent = 'Finalizing...';
    const image_url = await getDownloadURL(mainRef);
    const thumb_url = await getDownloadURL(thumbRef);


    const ALLOWED = ['identifier','clay_body','notes',
      'image_url','thumb_url','width','height',
      'submitted_at','glazes','glaze_names'];

    // build doc without undefined fields
    const docData = {
      clay_body,
      notes,
      glazes,
      glaze_names,
      image_url,
      thumb_url,
      width: main.width,
      height: main.height,
      submitted_at: serverTimestamp()
    };
    if (identifier) docData.identifier = identifier;

    // validations against your allow-list
    const keys   = Object.keys(docData);
    const extras = keys.filter(k => !ALLOWED.includes(k));
    console.log('DOC KEYS =', keys);
    console.log('EXTRA KEYS =', extras);
    if (extras.length) throw new Error('Unexpected fields: ' + extras.join(', '));
    if (docData.identifier != null && typeof docData.identifier !== 'string') throw new Error('identifier must be string');
    if (docData.notes != null && typeof docData.notes !== 'string') throw new Error('notes must be string');
    if (typeof docData.image_url !== 'string') throw new Error('image_url must be string');
    if (docData.glazes != null && !Array.isArray(docData.glazes)) throw new Error('glazes must be an array');
    if (docData.glaze_names != null && !Array.isArray(docData.glaze_names)) throw new Error('glaze_names must be an array');

    // ✅ write with your custom ID
    const ref = doc(collection(db, 'items'), docId);
    await setDoc(ref, docData);
    console.log('Created doc with ID:', docId);


    statusEl.textContent = 'Submitted. Thank you!';
    form.reset();
    const rows = glazesWrap.querySelectorAll('.glaze-row');
    rows.forEach((r, idx) => { if (idx > 0) r.remove(); });
    glazesWrap.querySelector('.glaze-name')?.focus();

    setTimeout(() => { submitModal?.close?.(); statusEl.textContent = ''; }, 800);

  } catch (err) {
    console.error('UPLOAD/WRITE error:', err);
    statusEl.textContent = `Submission failed: ${(err.code || '').toString()} ${err.message || err}`;
  } finally {
    submitBtn.disabled = false;
  }
});


document.getElementById('test-doc')?.addEventListener('click', async () => {
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const sample = {
      clay_body: 'White',
      notes: '',
      glazes: [{ name: 'Shino', layers: 1, application: '' }],
      glaze_names: ['Shino'],
      image_url: 'https://example.com/image.jpg',
      thumb_url: 'https://example.com/thumb.jpg',
      width: 800, height: 800,
      submitted_at: serverTimestamp(),
    };
    await addDoc(itemsCol, sample);
    alert('Firestore create OK');
  } catch (e) {
    console.error('Doc test failed:', e);
    alert('Firestore error: ' + (e.code || e.message));
  }
});
