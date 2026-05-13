// Shop page logic

let _products = [];
let _cart = { items: [], total: 0 };
let _role = '';
let _userId = null;
let _currentStoreId = null;
let _selectedPayment = 'card';
let _storeAddress = null;

async function initShop() {
  const token = localStorage.getItem('dh_token');
  if (!token) { window.location.href = '/login.html'; return; }

  const me = await apiFetch('/api/me');
  if (!me) { window.location.href = '/login.html'; return; }
  _role = me.role;
  _userId = me.id;

  // Set dashboard link
  const roleMap = { admin: 'admin', investor: 'investor', store_owner: 'owner', distributor: 'distributor', rep: 'rep' };
  const token2 = token;
  document.getElementById('dashboard-link').href = `/dashboard-${roleMap[_role]}.html?t=${token2}`;

  const roleLabels = { store_owner: 'Wholesaler', distributor: 'Distributor', rep: 'Rep', admin: 'Admin' };
  document.getElementById('user-role').textContent = roleLabels[_role] || _role;
  document.getElementById('user-role').className = `role-badge ${_role}`;

  initTheme();
  renderLogo(document.getElementById('logo-container'));

  if (_role === 'store_owner') {
    document.getElementById('shop-subtitle').textContent = 'Your prices are set per your wholesaler agreement';
    // prefill shipping from store
    const data = await apiFetch('/api/stores');
    if (data && data.stores && data.stores[0]) {
      _storeAddress = data.stores[0];
    }
  }

  // Reps always order for themselves — store selector removed
  // (reps handle store fulfilment independently after receiving their shipment)

  if (_role === 'distributor') {
    // Auto-select store from URL param
    const urlStoreId = new URLSearchParams(window.location.search).get('store_id');
    if (urlStoreId) {
      _currentStoreId = parseInt(urlStoreId);
      const data = await apiFetch('/api/stores');
      if (data && data.stores) {
        _storeAddress = data.stores.find(s => s.id === _currentStoreId) || null;
      }
    }
  }

  await loadProducts();
  await loadCart();
  updateShoppingForBanner();

function updateShoppingForBanner() {
  const banner = document.getElementById('shopping-for-banner');
  const nameEl = document.getElementById('shopping-for-name');
  const subEl = document.getElementById('shopping-for-sub');
  if (!banner) return;
  if (_currentStoreId && _storeAddress) {
    nameEl.textContent = `Shopping for: ${_storeAddress.name}`;
    subEl.textContent = `${_storeAddress.city || ''} ${_storeAddress.state || ''} · ${_storeAddress.category || ''}`.trim();
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}
}

async function loadProducts() {
  const products = await apiFetch('/api/products');
  _products = products || [];
  renderProducts();
}

function renderProducts() {
  const grid = document.getElementById('products-grid');
  if (!_products.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">No products available.</p>';
    return;
  }
  grid.innerHTML = _products.map(p => {
    const price = p.my_price !== null && p.my_price !== undefined ? `$${parseFloat(p.my_price).toFixed(2)}` : 'No price set';
    const hasPrice = p.my_price !== null && p.my_price !== undefined;
    const stockClass = p.stock < 20 ? 'low' : '';
    const imgEl = p.image_url
      ? `<div class="product-img-wrap"><img class="product-img" src="${p.image_url}" alt="${esc(p.name)}" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('failed')"><span class="product-img-fallback">📦</span></div>`
      : `<div class="product-img-wrap failed"><span class="product-img-fallback">📦</span></div>`;
    return `
      <div class="product-card">
        ${imgEl}
        <div class="product-body">
          <div class="product-name">${esc(p.name)}</div>
          ${p.sku ? `<div class="product-sku">SKU: ${esc(p.sku)}</div>` : ''}
          <div class="product-desc">${esc(p.description || '')}</div>
          <div style="margin-top:auto;">
            <div class="product-price">${price}</div>
            <div class="product-stock ${stockClass}">${p.stock > 0 ? `${p.stock.toLocaleString()} in stock` : '⚠ Out of stock'}</div>
            <div class="qty-row">
              <button class="qty-btn" onclick="changeQty(${p.id}, -1)">−</button>
              <input class="qty-input" type="number" id="qty-${p.id}" value="1" min="1" max="${p.stock}" step="1"
                oninput="validateQtyInput(this, ${p.id})"
                onkeydown="if(['e','E','+','-','.'].includes(event.key)) event.preventDefault()">
              <button class="qty-btn" onclick="changeQty(${p.id}, 1)">+</button>
            </div>
            <button class="add-btn" onclick="addToCart(${p.id})" ${!hasPrice || p.stock === 0 ? 'disabled' : ''}>${!hasPrice ? 'No Price Set' : p.stock === 0 ? 'Out of Stock' : 'Add to Cart'}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function changeQty(productId, delta) {
  const input = document.getElementById(`qty-${productId}`);
  const product = _products.find(p => p.id === productId);
  const max = product ? product.stock : 9999;
  let val = parseInt(input.value) || 1;
  val = Math.min(max, Math.max(1, val + delta));
  input.value = val;
}

function validateQtyInput(input, productId) {
  const product = _products.find(p => p.id === productId);
  const max = product ? product.stock : 9999;
  // Strip anything that's not a digit
  let val = input.value.replace(/[^0-9]/g, '');
  let num = parseInt(val) || 1;
  num = Math.min(max, Math.max(1, num));
  input.value = num;
}

async function addToCart(productId) {
  const qty = parseInt(document.getElementById(`qty-${productId}`).value) || 1;
  const body = { product_id: productId, quantity: qty };
  if (_currentStoreId) body.store_id = _currentStoreId;
  const cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
  if (cart) { _cart = cart; renderCart(); showToast('Added to cart', 'success'); }
}

async function loadCart() {
  const params = _currentStoreId ? `?store_id=${_currentStoreId}` : '';
  const cart = await apiFetch(`/api/cart${params}`);
  if (cart) { _cart = cart; renderCart(); }
}

function renderCart() {
  const wrap = document.getElementById('cart-items-wrap');
  const totalRow = document.getElementById('cart-total-row');
  const shippingNote = document.getElementById('cart-shipping-note');
  const checkoutBtn = document.getElementById('checkout-btn');

  if (!_cart.items || !_cart.items.length) {
    wrap.innerHTML = '<div class="cart-empty">Your cart is empty</div>';
    totalRow.style.display = 'none';
    shippingNote.style.display = 'none';
    checkoutBtn.disabled = true;
    return;
  }

  wrap.innerHTML = _cart.items.map(item => `
    <div class="cart-item">
      ${item.image_url ? `<img class="cart-item-img" src="${item.image_url}" alt="">` : '<div class="cart-item-img" style="background:var(--bg-secondary);border-radius:6px;"></div>'}
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(item.name)}</div>
        <div class="cart-item-price">$${parseFloat(item.price_at_add).toFixed(2)} each</div>
        <div class="cart-item-qty">
          <button class="cart-qty-btn" onclick="updateCartItem(${item.id}, ${item.quantity - 1})">−</button>
          <span class="cart-qty-val">${item.quantity}</span>
          <button class="cart-qty-btn" onclick="updateCartItem(${item.id}, ${item.quantity + 1})">+</button>
        </div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">$${(item.price_at_add * item.quantity).toFixed(2)}</div>
        <button class="cart-item-remove" onclick="removeCartItem(${item.id})">🗑</button>
      </div>
    </div>
  `).join('');

  const total = _cart.items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  document.getElementById('cart-total-val').textContent = `$${total.toFixed(2)}`;
  totalRow.style.display = 'flex';
  shippingNote.style.display = 'block';
  checkoutBtn.disabled = false;
}

async function updateCartItem(itemId, qty) {
  const cart = await apiFetch(`/api/cart/item/${itemId}`, { method: 'PATCH', body: JSON.stringify({ quantity: qty }) });
  if (cart) { _cart = cart; renderCart(); }
}

async function removeCartItem(itemId) {
  const cart = await apiFetch(`/api/cart/item/${itemId}`, { method: 'DELETE' });
  if (cart) { _cart = cart; renderCart(); }
}

async function clearCart() {
  const params = _currentStoreId ? `?store_id=${_currentStoreId}` : '';
  await apiFetch(`/api/cart${params}`, { method: 'DELETE' });
  _cart = { items: [], total: 0 };
  renderCart();
}

// Checkout
function showCheckout() {
  const items = _cart.items || [];
  if (!items.length) return;

  const subtotal = items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  const shipping = subtotal > 500 ? 0 : 15;
  const total = subtotal + shipping;

  document.getElementById('co-subtotal').textContent = `$${subtotal.toFixed(2)}`;
  document.getElementById('co-shipping').textContent = shipping === 0 ? 'FREE' : `$${shipping.toFixed(2)}`;
  document.getElementById('co-total').textContent = `$${total.toFixed(2)}`;

  document.getElementById('checkout-items').innerHTML = items.map(i => `
    <div class="order-summary-row">
      <span>${esc(i.name)} × ${i.quantity}</span>
      <span>$${(i.price_at_add * i.quantity).toFixed(2)}</span>
    </div>
  `).join('');

  // Prefill address
  if (_storeAddress) {
    document.getElementById('ship-name').value = _storeAddress.owner_name || _storeAddress.name || '';
    document.getElementById('ship-address').value = _storeAddress.address || '';
    document.getElementById('ship-city').value = _storeAddress.city || '';
    document.getElementById('ship-state').value = _storeAddress.state || '';
    document.getElementById('ship-zip').value = _storeAddress.zip || '';
  } else {
    // Clear for reps ordering for themselves
    document.getElementById('ship-name').value = '';
    document.getElementById('ship-address').value = '';
    document.getElementById('ship-city').value = '';
    document.getElementById('ship-state').value = '';
    document.getElementById('ship-zip').value = '';
  }

  document.getElementById('checkout-modal').classList.add('active');
}

function selectPayment(method) {
  _selectedPayment = method;
  document.getElementById('pay-card').classList.toggle('selected', method === 'card');
  document.getElementById('pay-invoice').classList.toggle('selected', method === 'invoice');
}

async function placeOrder() {
  const addr = document.getElementById('ship-address').value.trim();
  const city = document.getElementById('ship-city').value.trim();
  const state = document.getElementById('ship-state').value.trim();
  const zip = document.getElementById('ship-zip').value.trim();
  if (!addr || !city || !state || !zip) { showToast('Please fill in the complete shipping address', 'error'); return; }

  const body = {
    store_id: _currentStoreId || null,
    payment_method: _selectedPayment,
    shipping_name: document.getElementById('ship-name').value.trim(),
    shipping_address: addr,
    shipping_city: city,
    shipping_state: state,
    shipping_zip: zip,
    notes: document.getElementById('order-notes').value.trim()
  };

  const order = await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(body) });
  if (order && order.id) {
    document.getElementById('checkout-modal').classList.remove('active');
    const msg = _selectedPayment === 'invoice'
      ? `Order #${order.id} placed! An invoice will be sent to you on net-30 terms. Total: $${parseFloat(order.total).toFixed(2)}`
      : `Order #${order.id} confirmed! Payment of $${parseFloat(order.total).toFixed(2)} processed.`;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-modal').classList.add('active');
    _cart = { items: [], total: 0 };
    renderCart();
  } else if (order && order.error) {
    showToast(order.error, 'error');
  }
}

initShop();
