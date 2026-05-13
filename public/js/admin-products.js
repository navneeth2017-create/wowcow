// Admin product management

let _allProducts = [];

// Internal tier definitions — labels shown to admin only, never to end users
const PRODUCT_TIERS = [
  { key: 'master_distributor', label: 'Master Distributor' },
  { key: 'distributor',        label: 'Distributor' },
  { key: 'rep',                label: 'Sales Rep' },
  { key: 'store_owner',        label: 'Wholesale / Store Owner' },
];

async function loadProductsTab() {
  const products = await apiFetch('/api/products/all');
  _allProducts = products || [];

  // Low stock warning banner
  const redProducts    = _allProducts.filter(p => p.active === 1 && p.stock <= 50);
  const yellowProducts = _allProducts.filter(p => p.active === 1 && p.stock >= 51 && p.stock <= 99);
  const bannerEl = document.getElementById('products-low-stock-banner');
  if (bannerEl) {
    if (redProducts.length > 0 || yellowProducts.length > 0) {
      const outOfStock = redProducts.filter(p => p.stock === 0);
      let html = '';

      if (redProducts.length > 0) {
        html += `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;flex-shrink:0;filter:hue-rotate(315deg) saturate(4) brightness(0.85);">⚠️</span>
            <div>
              <span style="font-size:14px;font-weight:700;color:#dc2626;">
                ${redProducts.length} product${redProducts.length>1?'s are':' is'} critically low
              </span>
              ${outOfStock.length > 0
                ? `<div style="font-size:12px;color:#ef4444;margin-top:2px;">${outOfStock.length} item${outOfStock.length>1?'s':''} completely out of stock</div>`
                : ''}
              <div style="font-size:12px;color:#f87171;margin-top:6px;line-height:1.8;">
                ${redProducts.map(p => `<span style="display:inline-block;margin-right:14px;">
                  ${esc(p.name)}: <strong>${p.stock === 0 ? 'Out of Stock' : p.stock + ' left'}</strong>
                </span>`).join('')}
              </div>
            </div>
          </div>`;
      }

      if (yellowProducts.length > 0) {
        html += `
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;flex-shrink:0;">⚠️</span>
            <div>
              <span style="font-size:14px;font-weight:700;color:#d97706;">
                ${yellowProducts.length} product${yellowProducts.length>1?'s are':' is'} getting low
              </span>
              <div style="font-size:12px;color:#f59e0b;margin-top:6px;line-height:1.8;">
                ${yellowProducts.map(p => `<span style="display:inline-block;margin-right:14px;">
                  ${esc(p.name)}: <strong>${p.stock} left</strong>
                </span>`).join('')}
              </div>
            </div>
          </div>`;
      }

      bannerEl.innerHTML = html;
      bannerEl.style.display = 'block';
    } else {
      bannerEl.innerHTML = `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">✅</span>
          <span style="font-size:14px;font-weight:600;color:#16a34a;">All products are well stocked</span>
        </div>`;
      bannerEl.style.display = 'block';
    }
  }

  // Refresh the tab pulse badge
  if (typeof checkLowStockBadge === 'function') checkLowStockBadge();

  renderProductsTable();
}

function renderProductsTable() {
  const tbody = document.getElementById('products-tbody');
  if (!_allProducts.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No products yet. Add your first product.</td></tr>';
    return;
  }
  tbody.innerHTML = _allProducts.map((p, i) => {
    const prices = PRODUCT_TIERS.map(t => {
      const rp = (p.role_prices || []).find(x => x.role === t.key);
      return rp ? `<span style="white-space:nowrap;">${t.label}: <strong>$${parseFloat(rp.price).toFixed(2)}</strong></span>` : '';
    }).filter(Boolean).join('<br>');
    const statusBadge = p.active === 2
      ? `<span class="status-badge coming-soon">Coming Soon</span>`
      : p.active === 1
        ? `<span class="status-badge active">Active</span>`
        : `<span class="status-badge inactive">Inactive</span>`;
    const imgEl = p.image_url
      ? `<img src="${p.image_url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;" onerror="this.outerHTML='<div style=\\'width:44px;height:44px;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;\\'>💊</div>'">`
      : `<div style="width:44px;height:44px;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">💊</div>`;
    const preorderInfo = p.active === 2
      ? `<span style="font-size:11px;color:#7c3aed;font-weight:600;display:block;margin-top:4px;">👥 ${p.preorder_count || 0} interested</span>`
      : '';
    return `
      <tr class="table-row-anim" style="animation-delay:${i * 30}ms">
        <td>${imgEl}</td>
        <td style="font-weight:500">${esc(p.name)}${preorderInfo}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(p.sku || '—')}</td>
        <td style="font-size:12px;line-height:1.8;">${prices || '<span style="color:var(--text-muted)">No prices set</span>'}</td>
        <td>${p.active === 2 ? '<span style="color:var(--text-muted);font-size:13px;">—</span>' : p.stock}</td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-outline" onclick="showEditProduct(${p.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function showAddProductModal() {
  document.getElementById('product-modal-title').textContent = 'Add Product';
  document.getElementById('product-form').reset();
  document.getElementById('product-id').value = '';
  document.getElementById('product-preview-img').style.display = 'none';
  document.getElementById('product-modal').classList.add('active');
}

function showEditProduct(id) {
  const p = _allProducts.find(x => x.id === id);
  if (!p) return;
  document.getElementById('product-modal-title').textContent = 'Edit Product';
  document.getElementById('product-id').value = p.id;
  document.getElementById('pf-name').value = p.name;
  document.getElementById('pf-sku').value = p.sku || '';
  document.getElementById('pf-description').value = p.description || '';
  document.getElementById('pf-stock').value = p.stock;
  document.getElementById('pf-active').value = String(p.active ?? 1);
  document.getElementById('pf-image-url').value = p.image_url || '';
  updateImagePreview(p.image_url);
  // Fill all tier prices
  for (const t of PRODUCT_TIERS) {
    const rp = (p.role_prices || []).find(x => x.role === t.key);
    const el = document.getElementById(`pf-price-${t.key}`);
    if (el) el.value = rp ? rp.price : '';
  }
  document.getElementById('product-modal').classList.add('active');
}

function updateImagePreview(url) {
  const img = document.getElementById('product-preview-img');
  if (url && url.trim()) {
    img.src = url;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  } else {
    img.style.display = 'none';
  }
}

function handleImageUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('pf-image-url').value = e.target.result;
    updateImagePreview(e.target.result);
  };
  reader.readAsDataURL(file);
}

async function handleProductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('product-id').value;
  const prices = {};
  for (const t of PRODUCT_TIERS) {
    const el = document.getElementById(`pf-price-${t.key}`);
    if (el && el.value !== '') prices[t.key] = el.value;
  }
  const body = {
    name: document.getElementById('pf-name').value.trim(),
    sku: document.getElementById('pf-sku').value.trim(),
    description: document.getElementById('pf-description').value.trim(),
    stock: parseInt(document.getElementById('pf-stock').value) || 0,
    active: parseInt(document.getElementById('pf-active').value),
    image_url: document.getElementById('pf-image-url').value.trim(),
    prices
  };

  let result;
  if (id) {
    result = await apiFetch(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  } else {
    result = await apiFetch('/api/products', { method: 'POST', body: JSON.stringify(body) });
  }

  if (result && result.id) {
    showToast(id ? 'Product updated' : 'Product added', 'success');
    closeModal();
    loadProductsTab();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

async function deleteProduct(id) {
  const p = _allProducts.find(x => x.id === id);
  if (!confirm(`Delete "${p?.name}"? This cannot be undone.`)) return;
  const result = await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
  if (result && result.success) {
    showToast('Product deleted', 'success');
    loadProductsTab();
  }
}
