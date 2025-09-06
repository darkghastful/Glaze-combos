async function loadData() {
  const res = await fetch('data/items.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load items.json');
  return await res.json();
}

function uniqueSorted(arr) { return Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>a.localeCompare(b)); }

function populateFilters(items) {
  const glazes = uniqueSorted(items.map(i => i.glaze));
  const clays  = uniqueSorted(items.map(i => i.clay_body));
  const selGlaze = document.getElementById('filter-glaze');
  const selClay  = document.getElementById('filter-clay');
  for (const g of glazes) selGlaze.insertAdjacentHTML('beforeend', `<option>${g}</option>`);
  for (const c of clays)  selClay.insertAdjacentHTML('beforeend', `<option>${c}</option>`);
}

function renderGallery(items) {
  const $g = document.getElementById('gallery');
  $g.innerHTML = '';
  for (const item of items) {
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
  const $m = document.getElementById('detail-modal');
  document.getElementById('detail-image').src = item.image_url;
  document.getElementById('detail-title').textContent = item.identifier || 'Untitled';
  document.getElementById('detail-glaze').textContent = item.glaze || '—';
  document.getElementById('detail-clay').textContent = item.clay_body || '—';
  document.getElementById('detail-identifier').textContent = item.identifier || '—';
  document.getElementById('detail-notes').textContent = item.notes || '—';
  document.getElementById('detail-tags').textContent = (item.tags || []).join(', ') || '—';
  document.getElementById('detail-date').textContent = item.submitted_at || '—';
  $m.showModal();
}

function attachFilterHandlers(allItems) {
  const selGlaze = document.getElementById('filter-glaze');
  const selClay  = document.getElementById('filter-clay');
  const inpId    = document.getElementById('filter-id');

  function apply() {
    const g = selGlaze.value.trim().toLowerCase();
    const c = selClay.value.trim().toLowerCase();
    const idq = inpId.value.trim().toLowerCase();
    const filtered = allItems.filter(i => {
      const glazeOk = !g || (i.glaze || '').toLowerCase() === g;
      const clayOk  = !c || (i.clay_body || '').toLowerCase() === c;
      const idOk    = !idq || (i.identifier || '').toLowerCase().includes(idq);
      return glazeOk && clayOk && idOk;
    });
    renderGallery(filtered);
  }
  selGlaze.addEventListener('change', apply);
  selClay.addEventListener('change', apply);
  inpId.addEventListener('input', apply);
}

(function main(){
  const modal = document.getElementById('detail-modal');
  document.getElementById('modal-close').addEventListener('click', ()=> modal.close());
  modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.close(); });
  loadData().then(items => {
    populateFilters(items);
    renderGallery(items);
    attachFilterHandlers(items);
  }).catch(err => {
    document.getElementById('gallery').innerHTML = `<p>Failed to load gallery: ${err.message}</p>`;
  });
})();