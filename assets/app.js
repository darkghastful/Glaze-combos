// ---------- Firebase imports ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
// Optional App Check (uncomment + add your site key, then enforce in console)
// import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Capacity & image settings (tuned for ≤ 3k pieces under 5GB) ----------
const MAX_LIBRARY_BYTES = 5e9;          // 5 GB (decimal)
const EXPECTED_MAX_SUBMISSIONS = 3000;  // you said ≤ 3k
const SAFETY = 0.85;                    // 15% headroom

const PER_SUBMISSION_BUDGET = Math.floor(MAX_LIBRARY_BYTES * SAFETY / EXPECTED_MAX_SUBMISSIONS);
// Allocate 90% to main image, 10% to thumbnail
const MAIN_BUDGET_BYTES  = Math.floor(PER_SUBMISSION_BUDGET * 0.90);
const THUMB_BUDGET_BYTES = PER_SUBMISSION_BUDGET - MAIN_BUDGET_BYTES;

// Visual max dimensions (keeps detail on glaze while controlling size)
const IMAGE_MAX_LONG_EDGE = 1600; // px
const THUMB_MAX_LONG_EDGE = 480;  // px

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
    for (let i = 0; i < 6; i++) { // 6 steps ≈ good enough
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
// Optional App Check (uncomment when you have a site key and want to enforce)
// initializeAppCheck(app, { provider: new ReCaptchaV3Provider("YOUR_RECAPTCHA_SITE_KEY"), isTokenAutoRefreshEnabled: true });

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

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
  const glazes = uniqueSorted(items.map(i => i.glaze));
  const clays  = uniqueSorted(items.map(i => i.clay_body));
  const key = JSON.stringify([glazes, clays]);
  if (key === lastFilterKey) return;
  lastFilterKey = key;

  const selGlaze = document.getElementById('filter-glaze');
  const selClay  = document.getElementById('filter-clay');
  selGlaze.length = 1; // keep the "All" option
  selClay.length = 1;
  for (const g of glazes) selGlaze.insertAdjacentHTML('beforeend', `<option>${g}</option>`);
  for (const c of clays)  selClay.insertAdjacentHTML('beforeend', `<option>${c}</option>`);
}

function renderGallery(items) {
  const g = document.getElementById('filter-glaze').value.trim().toLowerCase();
  const c = document.getElementById('filter-clay').value.trim().toLowerCase();
  const idq = document.getElementById('filter-id').value.trim().toLowerCase();

  const filtered = items.filter(i => {
    const glazeOk = !g || (i.glaze || '').toLowerCase() === g;
    const clayOk  = !c || (i.clay_body || '').toLowerCase() === c;
    const idOk    = !idq || (i.identifier || '').toLowerCase().includes(idq);
    return glazeOk && clayOk && idOk;
  });

  const $g = document.getElementById('gallery');
  $g.innerHTML = '';
  for (const item of filtered) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" loading="lazy" src="${item.thumb_url || item.image_url}" alt="${item.identifier || 'Pottery'}" />
      <div class="meta">
        <div>
          <div class="title">${item.identifier || 'Untitled'}</div>
          <div class="sub">${[item.glaze, item.clay_body].filter(Boolean).join(' • ')}</div>
        </div>
      </div>
      <button class="open" aria-label="Open details"></button>
    `;
    card.querySelector('button.open').addEventListener('click', () => openDetail(item));
    $g.appendChild(card);
  }
}

function openDetail(item) {
  document.getElementById('detail-image').src = item.image_url;
  document.getElementById('detail-title').textContent = item.identifier || 'Untitled';
  document.getElementById('detail-glaze').textContent = item.glaze || '—';
  document.getElementById('detail-clay').textContent = item.clay_body || '—';
  document.getElementById('detail-identifier').textContent = item.identifier || '—';
  document.getElementById('detail-notes').textContent = item.notes || '—';
  document.getElementById('detail-tags').textContent = (item.tags || []).join(', ') || '—';
  const dt = item.submitted_at?.toDate?.() || item.submitted_at;
  document.getElementById('detail-date').textContent = dt ? new Date(dt).toLocaleString() : '—';
  modal.showModal();
}

// Filters -> re-render
document.getElementById('filter-glaze').addEventListener('change',  ()=> renderGallery(itemsCache));
document.getElementById('filter-clay').addEventListener('change',   ()=> renderGallery(itemsCache));
document.getElementById('filter-id').addEventListener('input',      ()=> renderGallery(itemsCache));

// ---------- Submit handler with compression & budgets ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const fd = new FormData(form);
  const identifier = (fd.get('identifier') || '').toString().trim();
  const glaze      = (fd.get('glaze') || '').toString().trim();
  const clay_body  = (fd.get('clay_body') || '').toString().trim();
  const tagsCsv    = (fd.get('tags') || '').toString();
  const tags       = tagsCsv.split(',').map(s => s.trim()).filter(Boolean);
  const notes      = (fd.get('notes') || '').toString();
  const file       = fd.get('image');

  if (!identifier || !file || !file.size) {
    statusEl.textContent = 'Please provide an identifier and an image.';
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
    const stamp    = Date.now();

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

    await addDoc(itemsCol, {
      identifier, glaze, clay_body, notes, tags,
      image_url, thumb_url,
      width: main.width, height: main.height,
      submitted_at: serverTimestamp()
    });

    statusEl.textContent = 'Submitted. Thank you!';
    form.reset();
    setTimeout(() => { submitModal?.close?.(); statusEl.textContent = ''; }, 800);

  } catch (err) {
    console.error(err);
    statusEl.textContent = `Submission failed: ${err.message || err}`;
  } finally {
    submitBtn.disabled = false;
  }
});
