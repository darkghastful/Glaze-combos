import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

// Init Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Ensure anonymous auth
signInAnonymously(auth).catch(console.error);

// UI hooks
const modal = document.getElementById('detail-modal');
const submitModal = document.getElementById('submit-modal');
document.getElementById('modal-close').addEventListener('click', ()=> modal.close());
modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.close(); });

document.getElementById('open-submit').addEventListener('click', ()=> submitModal.showModal());
document.getElementById('submit-close').addEventListener('click', ()=> submitModal.close());
submitModal.addEventListener('click', (e)=>{ if (e.target === submitModal) submitModal.close(); });

const form = document.getElementById('submit-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('submit-status');

// Live gallery from Firestore
const itemsCol = collection(db, 'items');
const q = query(itemsCol, orderBy('submitted_at', 'desc'));
const unsubscribe = onSnapshot(q, (snap) => {
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateFilters(items);
  renderGallery(items);
}, (err)=>{
  console.error(err);
  document.getElementById('gallery').innerHTML = `<p>Failed to load gallery: ${err.message}</p>`;
});

function uniqueSorted(arr) { return Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>a.localeCompare(b)); }

let lastItemsCache = [];
function populateFilters(items) {
  // Only repopulate when keys change
  const glazes = uniqueSorted(items.map(i => i.glaze));
  const clays  = uniqueSorted(items.map(i => i.clay_body));
  if (JSON.stringify([glazes,clays]) === JSON.stringify(lastItemsCache)) return;
  lastItemsCache = [glazes, clays];
  const selGlaze = document.getElementById('filter-glaze');
  const selClay  = document.getElementById('filter-clay');
  // reset except first option
  selGlaze.length = 1; selClay.length = 1;
  for (const g of glazes) selGlaze.insertAdjacentHTML('beforeend', `<option>${g}</option>`);
  for (const c of clays)  selClay.insertAdjacentHTML('beforeend', `<option>${c}</option>`);
}

function renderGallery(items) {
  const selGlaze = document.getElementById('filter-glaze').value.trim().toLowerCase();
  const selClay  = document.getElementById('filter-clay').value.trim().toLowerCase();
  const idq      = document.getElementById('filter-id').value.trim().toLowerCase();
  const filtered = items.filter(i => {
    const glazeOk = !selGlaze || (i.glaze || '').toLowerCase() === selGlaze;
    const clayOk  = !selClay  || (i.clay_body || '').toLowerCase() === selClay;
    const idOk    = !idq      || (i.identifier || '').toLowerCase().includes(idq);
    return glazeOk && clayOk && idOk;
  });

  const $g = document.getElementById('gallery');
  $g.innerHTML = '';
  for (const item of filtered) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" loading="lazy" src="${item.image_url}" alt="${item.identifier || 'Pottery'}" />
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

// Filter handlers
document.getElementById('filter-glaze').addEventListener('change', ()=> renderGalleryCache());
document.getElementById('filter-clay').addEventListener('change',  ()=> renderGalleryCache());
document.getElementById('filter-id').addEventListener('input',     ()=> renderGalleryCache());
function renderGalleryCache(){
  // rely on the latest items from onSnapshot
  // Slight optimization: query DOM for existing cards is enough, but we rebuild to keep simple.
  // No-op; onSnapshot will rerender soon. Here we just trigger by cloning lastItemsCache.
  // Instead, call renderGallery directly using current DOM-derived filters and last snapshot items.
  // We'll store last snapshot items in window for access.
}
let lastSnapshotItems = [];
onSnapshot(q, (snap)=>{
  lastSnapshotItems = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  populateFilters(lastSnapshotItems);
  renderGallery(lastSnapshotItems);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const identifier = (fd.get('identifier')||'').toString().trim();
  const glaze = (fd.get('glaze')||'').toString().trim();
  const clay_body = (fd.get('clay_body')||'').toString().trim();
  const tagsCsv = (fd.get('tags')||'').toString();
  const tags = tagsCsv.split(',').map(s=>s.trim()).filter(Boolean);
  const notes = (fd.get('notes')||'').toString();
  const file = fd.get('image');

  if (!identifier || !file || !file.size) { statusEl.textContent = 'Please provide an identifier and an image.'; return; }
  if (file.size > 10*1024*1024) { statusEl.textContent = 'Image too large (max 10 MB).'; return; }

  submitBtn.disabled = true;
  statusEl.textContent = 'Uploading...';

  try {
    // Ensure authed
    if (!auth.currentUser) await signInAnonymously(auth);
    const uid = auth.currentUser?.uid || 'anon';
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
    const filename = `${identifier.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${Date.now()}.${ext || 'jpg'}`;
    const objectRef = sref(storage, `images/${uid}/${filename}`);
    await uploadBytes(objectRef, file, { contentType: file.type || 'image/jpeg' });
    const url = await getDownloadURL(objectRef);

    await addDoc(itemsCol, {
      identifier, glaze, clay_body, notes, tags,
      image_url: url,
      submitted_at: serverTimestamp()
    });

    statusEl.textContent = 'Submitted! You can close this dialog.';
    form.reset();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Submission failed: ' + err.message;
  } finally {
    submitBtn.disabled = false;
  }
});
