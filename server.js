const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize, JWT_SECRET } = require('./middleware/auth');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}
async function one(text, params) { const r = await q(text, params); return r.rows[0] || null; }
async function all(text, params) { const r = await q(text, params); return r.rows; }

const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── EMAIL HELPER ──────────────────────────────────────────────────────────────
async function sendNotification(subject, htmlBody) {
  if (!resend) return; // silently skip if no API key configured
  try {
    const recipients = await all('SELECT email FROM notification_emails');
    if (!recipients.length) return;
    const to = recipients.map(r => r.email);
    await resend.emails.send({
      from: 'WowCow <notifications@wowcow.com>',
      to,
      subject,
      html: htmlBody
    });
  } catch(e) {
    console.error('Email notification failed:', e.message);
  }
}
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await q(schema);
  console.log('✅ Schema ready');

  // Seed default notification email
  await q("INSERT INTO notification_emails (email, label) VALUES ('d.n.holding7@gmail.com', 'Admin') ON CONFLICT DO NOTHING");

  // Seed admin if no users exist yet
  const existing = await one('SELECT id FROM users LIMIT 1');
  if (!existing) {
    console.log('🌱 No users found — running seed...');
    require('./db/seed');
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function logActivity(action, targetName, userEmail) {
  await q('INSERT INTO activity_log (action, target_name, user_email) VALUES ($1,$2,$3)', [action, targetName, userEmail]);
}

async function getPriceForUser(productId, userId, role) {
  const userPrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND user_id=$2', [productId, userId]);
  if (userPrice) return parseFloat(userPrice.price);
  const rolePrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND role=$2 AND user_id IS NULL', [productId, role]);
  return rolePrice ? parseFloat(rolePrice.price) : null;
}

// ── FAVICON ───────────────────────────────────────────────────────────────────
app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#2563eb"/><path d="M12 4L4 8V16L12 20L20 16V8L12 4Z" stroke="white" stroke-width="1.5" fill="none"/><path d="M4 8L12 12M12 12L20 8M12 12V20" stroke="white" stroke-width="1.5"/></svg>`);
});

// ── PROTECTED DASHBOARD SERVING ───────────────────────────────────────────────
function serveDashboard(allowedRoles) {
  return (req, res) => {
    const token = req.query.t;
    if (!token) return res.redirect('/login.html');
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (!allowedRoles.includes(user.role)) return res.redirect('/login.html');
      const roleFileMap = { admin:'admin', investor:'investor', store_owner:'owner', distributor:'distributor', rep:'rep' };
      res.sendFile(path.join(__dirname, 'public', `dashboard-${roleFileMap[user.role]}.html`));
    } catch { res.redirect('/login.html'); }
  };
}
app.get('/dashboard-admin.html', serveDashboard(['admin']));
app.get('/dashboard-investor.html', serveDashboard(['investor']));
app.get('/dashboard-owner.html', serveDashboard(['store_owner']));
app.get('/dashboard-distributor.html', serveDashboard(['distributor']));
app.get('/dashboard-rep.html', serveDashboard(['rep']));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, filePath) => { if (filePath.includes('dashboard-')) res.status(403).end('Forbidden'); }
}));

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await one('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is pending admin approval.' });
    if (user.status === 'inactive') return res.status(403).json({ error: 'Your account has been deactivated.' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, store_id: user.store_id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, name, phone, role, store_name, address, city, state, zip, category } = req.body;
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'Email, password, name, and role are required' });
    if (!['store_owner','distributor','rep'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = bcrypt.hashSync(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (role === 'store_owner') {
        if (!store_name) throw new Error('Store name is required');
        const sr = await client.query(
          `INSERT INTO stores (name,owner_name,email,address,city,state,zip,category,monthly_revenue,wholesale_price,retail_price,distribution_cost,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,0,'pending') RETURNING id`,
          [store_name, name, email.toLowerCase(), address||'', city||'', state||'', zip||'', category||'General']
        );
        const storeId = sr.rows[0].id;
        const ur = await client.query(
          `INSERT INTO users (email,password_hash,role,store_id,name,phone,status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
          [email.toLowerCase(), hash, 'store_owner', storeId, name, phone||'']
        );
        await client.query('INSERT INTO owner_stores (owner_id,store_id) VALUES ($1,$2)', [ur.rows[0].id, storeId]);
      } else {
        const ur = await client.query(
          `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
          [email.toLowerCase(), hash, role, name, phone||'']
        );
        if (role === 'rep') {
          await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,NULL,0.10)', [ur.rows[0].id]);
        }
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await logActivity('signup_request', `${name} (${role})`, email.toLowerCase());

    // Email notification
    const roleLabel = role === 'store_owner' ? 'Wholesaler' : role === 'distributor' ? 'Distributor' : 'Sales Rep';
    await sendNotification(
      `👤 New Account Request — ${name} (${roleLabel})`,
      `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="background:#2563eb;padding:24px 28px;">
          <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#93c5fd;">WowCow Distribution</p>
          <h1 style="margin:8px 0 0;font-size:22px;color:#ffffff;">New Account Request</h1>
        </div>
        <div style="padding:24px 28px;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Name</td><td style="padding:6px 0;font-weight:700;font-size:13px;">${name}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Email</td><td style="padding:6px 0;font-size:13px;">${email.toLowerCase()}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Phone</td><td style="padding:6px 0;font-size:13px;">${phone || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Role</td><td style="padding:6px 0;font-size:13px;"><strong>${roleLabel}</strong></td></tr>
            ${role === 'store_owner' ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Store</td><td style="padding:6px 0;font-size:13px;">${store_name || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Location</td><td style="padding:6px 0;font-size:13px;">${city || ''} ${state || ''}</td></tr>` : ''}
          </table>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;font-size:13px;color:#1d4ed8;">
            Log in to your admin dashboard → Pending Approvals to approve or deny this request.
          </div>
        </div>
        <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">WowCow Distribution — Admin Notifications</div>
      </div>`
    );

    res.status(201).json({ success: true, message: 'Account request submitted. An admin will review and approve your account.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', authenticate, (req, res) => res.json(req.user));

app.patch('/api/profile', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await one("SELECT id,email,name FROM users WHERE email=$1 AND status='active'", [email.toLowerCase()]);
    if (!user) return res.json({ success: true });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await q('UPDATE password_resets SET used=1 WHERE user_id=$1', [user.id]);
    await q('INSERT INTO password_resets (user_id,code,expires_at) VALUES ($1,$2,$3)', [user.id, code, expires]);
    res.json({ success: true, code, name: user.name || user.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) return res.status(400).json({ error: 'Email, code, and new password are required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await one("SELECT id FROM users WHERE email=$1 AND status='active'", [email.toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'Invalid email or code' });
    const reset = await one('SELECT * FROM password_resets WHERE user_id=$1 AND code=$2 AND used=0', [user.id, code]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired code' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), user.id]);
    await q('UPDATE password_resets SET used=1 WHERE id=$1', [reset.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIFICATION EMAILS ───────────────────────────────────────────────────────
app.get('/api/notification-emails', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT * FROM notification_emails ORDER BY created_at ASC')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notification-emails', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { email, label } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const existing = await one('SELECT id FROM notification_emails WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already added' });
    const result = await one(
      'INSERT INTO notification_emails (email, label) VALUES ($1,$2) RETURNING *',
      [email.toLowerCase(), label || '']
    );
    res.status(201).json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/notification-emails/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await q('DELETE FROM notification_emails WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STORES ────────────────────────────────────────────────────────────────────
app.get('/api/stores', authenticate, async (req, res) => {
  try {
    const { role, store_id, id: userId } = req.user;
    const { search, sort, order, page, limit, category, state, status } = req.query;

    if (role === 'store_owner') {
      const owned = await all(
        'SELECT s.* FROM stores s INNER JOIN owner_stores os ON os.store_id=s.id WHERE os.owner_id=$1',
        [userId]
      );
      if (owned.length > 0) {
        const avg = await one('SELECT AVG(monthly_revenue) as avg_revenue FROM stores');
        return res.json({ stores: owned, total: owned.length, network_avg: avg.avg_revenue });
      }
      const store = store_id ? await one('SELECT * FROM stores WHERE id=$1', [store_id]) : null;
      const avg = await one('SELECT AVG(monthly_revenue) as avg_revenue FROM stores');
      return res.json({ stores: store ? [store] : [], total: store ? 1 : 0, network_avg: avg.avg_revenue });
    }

    if (role === 'distributor') {
      const stores = await all(
        'SELECT s.* FROM stores s INNER JOIN distributor_stores ds ON ds.store_id=s.id WHERE ds.distributor_id=$1 ORDER BY s.name',
        [userId]
      );
      return res.json({ stores, total: stores.length });
    }

    if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (!rep) return res.json({ stores: [], total: 0 });
      const stores = await all(
        'SELECT s.* FROM stores s INNER JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=$1',
        [rep.id]
      );
      return res.json({ stores, total: stores.length });
    }

    const baseSelect = role === 'investor' ? 'SELECT id,name,monthly_revenue,status FROM stores' : 'SELECT * FROM stores';
    const conditions = [], params = [];
    let pi = 1;
    if (search) {
      if (role === 'admin') {
        conditions.push(`(name ILIKE $${pi} OR owner_name ILIKE $${pi+1} OR email ILIKE $${pi+2} OR city ILIKE $${pi+3})`);
        params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); pi+=4;
      } else { conditions.push(`name ILIKE $${pi}`); params.push(`%${search}%`); pi++; }
    }
    if (category) { conditions.push(`category=$${pi}`); params.push(category); pi++; }
    if (state) { conditions.push(`state=$${pi}`); params.push(state); pi++; }
    if (status) { conditions.push(`status=$${pi}`); params.push(status); pi++; }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const allowedSorts = ['name','monthly_revenue','city','state','category','owner_name','status'];
    const orderClause = (sort && allowedSorts.includes(sort)) ? ` ORDER BY ${sort} ${order==='desc'?'DESC':'ASC'}` : ' ORDER BY name ASC';
    const totalFiltered = (await one(`SELECT COUNT(*) as count FROM stores${where}`, params)).count;
    const pageNum = Math.max(1, parseInt(page)||1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit)||25));
    const offset = (pageNum-1)*pageSize;

    const stores = await all(`${baseSelect}${where}${orderClause} LIMIT $${pi} OFFSET $${pi+1}`, [...params, pageSize, offset]);
    const stats = await one('SELECT COUNT(*) as total, SUM(monthly_revenue) as total_revenue, AVG(monthly_revenue) as avg_revenue FROM stores');
    const byCategory = await all('SELECT category, SUM(monthly_revenue) as revenue, COUNT(*) as count FROM stores GROUP BY category ORDER BY revenue DESC');
    const top10 = await all('SELECT id,name,monthly_revenue FROM stores ORDER BY monthly_revenue DESC LIMIT 10');
    const bottom10 = await all('SELECT id,name,monthly_revenue FROM stores ORDER BY monthly_revenue ASC LIMIT 10');
    const byStatus = await all('SELECT status, COUNT(*) as count FROM stores GROUP BY status');

    const buckets = [0,50000,100000,150000,200000,250000,300000,400000,500000];
    const distribution = await Promise.all(buckets.map(async (min,i) => {
      const max = buckets[i+1] || 999999999;
      const label = i===buckets.length-1 ? `$${min/1000}k+` : `$${min/1000}k-${max/1000}k`;
      const count = (await one('SELECT COUNT(*) as count FROM stores WHERE monthly_revenue>=$1 AND monthly_revenue<$2', [min,max])).count;
      return { label, count, min, max };
    }));

    res.json({
      stores, total: stats.total, total_filtered: totalFiltered,
      total_revenue: stats.total_revenue, avg_revenue: stats.avg_revenue,
      page: pageNum, page_size: pageSize, total_pages: Math.ceil(totalFiltered/pageSize),
      by_category: byCategory, top10, bottom10, by_status: byStatus, distribution
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stores/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, owner_name, email, address, city, state, zip, category, monthly_revenue, wholesale_price, retail_price, distribution_cost, status } = req.body;
    if (!name || !owner_name || !email) return res.status(400).json({ error: 'Name, owner, and email are required' });
    const result = await one(
      `INSERT INTO stores (name,owner_name,email,address,city,state,zip,category,monthly_revenue,wholesale_price,retail_price,distribution_cost,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name,owner_name,email,address||'',city||'',state||'',zip||'',category||'General',
       monthly_revenue||0,wholesale_price||0,retail_price||0,distribution_cost||0,status||'active']
    );
    await logActivity('created', name, req.user.email);
    res.status(201).json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/stores/:id', authenticate, async (req, res) => {
  try {
    const { role, store_id } = req.user;
    const id = parseInt(req.params.id);
    if (role === 'store_owner' && store_id !== id) return res.status(403).json({ error: 'Access denied' });
    if (role === 'investor') return res.status(403).json({ error: 'Access denied' });
    const store = await one('SELECT * FROM stores WHERE id=$1', [id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const allowed = ['name','owner_name','email','address','city','state','zip','category','monthly_revenue','wholesale_price','retail_price','distribution_cost','status'];
    const updates = [], params = [];
    let pi = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) { updates.push(`${field}=$${pi}`); params.push(req.body[field]); pi++; }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);
    const updated = await one(`UPDATE stores SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    await logActivity(req.body.status && req.body.status !== store.status ? 'status_changed' : 'updated', store.name, req.user.email);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stores/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    await q('DELETE FROM store_notes WHERE store_id=$1', [req.params.id]);
    await q('DELETE FROM stores WHERE id=$1', [req.params.id]);
    await logActivity('deleted', store.name, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stores/bulk-delete', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No store IDs provided' });
    const placeholders = ids.map((_,i) => `$${i+1}`).join(',');
    const stores = await all(`SELECT name FROM stores WHERE id IN (${placeholders})`, ids);
    await q(`DELETE FROM store_notes WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM stores WHERE id IN (${placeholders})`, ids);
    for (const s of stores) await logActivity('deleted', s.name, req.user.email);
    res.json({ success: true, deleted: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FILTERS / ACTIVITY / NOTES / CSV ─────────────────────────────────────────
app.get('/api/filters', authenticate, async (req, res) => {
  try {
    const categories = (await all('SELECT DISTINCT category FROM stores ORDER BY category')).map(r=>r.category);
    const states = (await all('SELECT DISTINCT state FROM stores ORDER BY state')).map(r=>r.state);
    res.json({ categories, states });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity', authenticate, authorize('admin'), async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit)||10);
    res.json(await all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1', [limit]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stores/:id/notes', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT * FROM store_notes WHERE store_id=$1 ORDER BY created_at DESC', [req.params.id])); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stores/:id/notes', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const result = await one('INSERT INTO store_notes (store_id,note) VALUES ($1,$2) RETURNING *', [req.params.id, note.trim()]);
    res.status(201).json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/csv', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { search, category, state, status, ids } = req.query;
    const conditions = [], params = []; let pi = 1;
    if (ids) {
      const idList = ids.split(',').map(Number).filter(n=>!isNaN(n));
      if (idList.length) { conditions.push(`id IN (${idList.map((_,i)=>`$${pi+i}`).join(',')})`); params.push(...idList); pi+=idList.length; }
    }
    if (search) { conditions.push(`(name ILIKE $${pi} OR owner_name ILIKE $${pi+1} OR email ILIKE $${pi+2} OR city ILIKE $${pi+3})`); params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); pi+=4; }
    if (category) { conditions.push(`category=$${pi}`); params.push(category); pi++; }
    if (state) { conditions.push(`state=$${pi}`); params.push(state); pi++; }
    if (status) { conditions.push(`status=$${pi}`); params.push(status); pi++; }
    const stores = await all(`SELECT * FROM stores${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY name`, params);
    const headers = ['Name','Owner','Email','Address','City','State','Zip','Category','Monthly Revenue','Wholesale Price','Retail Price','Distribution Cost','Status'];
    const rows = stores.map(s => [s.name,s.owner_name,s.email,s.address,s.city,s.state,s.zip,s.category,s.monthly_revenue,s.wholesale_price,s.retail_price,s.distribution_cost,s.status].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename=wowcow-stores.csv');
    res.send([headers.join(','),...rows].join('\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.post('/api/users', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { email, password, name, phone, role } = req.body;
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'Email, password, name, and role are required' });
    if (!['admin','investor'].includes(role)) return res.status(400).json({ error: 'This endpoint only creates admin or investor accounts' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const result = await one(
      `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      [email.toLowerCase(), bcrypt.hashSync(password,10), role, name, phone||'']
    );
    await logActivity('created_user', `${name} (${role})`, req.user.email);
    res.status(201).json({ success: true, id: result.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT id,email,name,phone,role,status,pricing_tier FROM users ORDER BY role,name')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await q('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { store_ids } = req.body;
    if (!store_ids || !Array.isArray(store_ids)) return res.status(400).json({ error: 'store_ids array required' });
    for (const sid of store_ids) {
      await q('INSERT INTO owner_stores (owner_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pending-users', authenticate, authorize('admin'), async (req, res) => {
  try {
    res.json(await all(
      `SELECT u.id,u.email,u.name,u.phone,u.status,u.role,
              s.id as store_id,s.name as store_name,s.city,s.state,s.category
       FROM users u LEFT JOIN stores s ON s.id=u.store_id
       WHERE u.role IN ('store_owner','distributor','rep')
       ORDER BY u.status ASC, u.id DESC`
    ));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set/change pricing tier for any user
async function applyPricingTier(userId, tier, customPrices) {
  const products = await all('SELECT id FROM products WHERE active=1');
  for (const p of products) {
    let price = null;
    if (tier === 'custom' && customPrices && customPrices[p.id] !== undefined) {
      price = parseFloat(customPrices[p.id]);
    } else if (tier !== 'custom') {
      const rp = await one('SELECT price FROM product_prices WHERE product_id=$1 AND role=$2 AND user_id IS NULL', [p.id, tier]);
      if (rp) price = parseFloat(rp.price);
    }
    if (price !== null && !isNaN(price)) {
      await q(
        `INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,$2,NULL,$3)
         ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price`,
        [p.id, userId, price]
      );
    }
  }
  // Persist the tier name on the user so it can be displayed in the admin UI
  await q('UPDATE users SET pricing_tier=$1 WHERE id=$2', [tier, userId]);
}

app.patch('/api/users/:id/pricing', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { tier, custom_prices } = req.body || {};
    if (!tier) return res.status(400).json({ error: 'Tier is required' });
    await applyPricingTier(parseInt(req.params.id), tier, custom_prices);
    await logActivity('pricing_updated', user.name||user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
    if (user.store_id) await q("UPDATE stores SET status='active' WHERE id=$1", [user.store_id]);
    const { tier, custom_prices } = req.body || {};
    if (tier) await applyPricingTier(parseInt(req.params.id), tier, custom_prices);
    await logActivity('approved', user.name||user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id/reject', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q("UPDATE users SET status='inactive' WHERE id=$1", [req.params.id]);
    if (user.store_id) await q("UPDATE stores SET status='inactive' WHERE id=$1", [user.store_id]);
    await logActivity('rejected', user.name||user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPS ──────────────────────────────────────────────────────────────────────
app.get('/api/reps', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    if (role === 'rep') {
      const rep = await one('SELECT r.*,u.name,u.email,u.phone FROM reps r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1', [userId]);
      if (!rep) return res.json({ rep: null });
      const storeCount = (await one('SELECT COUNT(*) as count FROM rep_store_assignments WHERE rep_id=$1', [rep.id])).count;
      const stores = await all(
        'SELECT s.id,s.name,s.monthly_revenue,s.category,s.city,s.state FROM stores s JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=$1',
        [rep.id]
      );
      const storeRevenue = stores.reduce((a,s)=>a+parseFloat(s.monthly_revenue),0);
      const myCommission = storeRevenue * parseFloat(rep.commission_rate);
      const downline = await all(
        `SELECT r.id,r.commission_rate,u.name,u.email,
                (SELECT COUNT(*) FROM rep_store_assignments WHERE rep_id=r.id) as store_count,
                COALESCE((SELECT SUM(s2.monthly_revenue) FROM stores s2 JOIN rep_store_assignments rsa2 ON rsa2.store_id=s2.id WHERE rsa2.rep_id=r.id),0) as store_revenue
         FROM reps r JOIN users u ON u.id=r.user_id WHERE r.sponsor_id=$1`,
        [rep.id]
      );
      const sponsorCommission = downline.reduce((a,d)=>a+(parseFloat(d.store_revenue)*parseFloat(d.commission_rate)*0.05),0);
      return res.json({ rep, storeCount, stores, storeRevenue, myCommission, downline, sponsorCommission, totalEarnings: myCommission+sponsorCommission });
    }
    if (role === 'admin') {
      const reps = await all(
        `SELECT r.id,r.sponsor_id,r.commission_rate,u.id as user_id,u.name,u.email,u.phone,u.status,
                su.name as sponsor_name,
                (SELECT COUNT(*) FROM rep_store_assignments WHERE rep_id=r.id) as store_count,
                COALESCE((SELECT SUM(s.monthly_revenue) FROM stores s JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=r.id),0) as store_revenue
         FROM reps r JOIN users u ON u.id=r.user_id
         LEFT JOIN reps sr ON sr.id=r.sponsor_id LEFT JOIN users su ON su.id=sr.user_id`
      );
      return res.json(reps);
    }
    res.status(403).json({ error: 'Access denied' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reps/enroll', authenticate, authorize('rep'), async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const sponsorRep = await one('SELECT id FROM reps WHERE user_id=$1', [req.user.id]);
    if (!sponsorRep) return res.status(400).json({ error: 'Sponsor rep not found' });
    const client = await pool.connect();
    let newUserId;
    try {
      await client.query('BEGIN');
      const ur = await client.query(
        `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,'rep',$3,$4,'active') RETURNING id`,
        [email.toLowerCase(), bcrypt.hashSync(password,10), name, phone||'']
      );
      newUserId = ur.rows[0].id;
      await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,$2,0.10)', [newUserId, sponsorRep.id]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await logActivity('enrolled_rep', name, req.user.email);
    res.status(201).json({ success: true, userId: newUserId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reps', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, email, password, phone, sponsor_rep_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const client = await pool.connect();
    let newUserId;
    try {
      await client.query('BEGIN');
      const ur = await client.query(
        `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,'rep',$3,$4,'active') RETURNING id`,
        [email.toLowerCase(), bcrypt.hashSync(password,10), name, phone||'']
      );
      newUserId = ur.rows[0].id;
      await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,$2,0.10)', [newUserId, sponsor_rep_id||null]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await logActivity('created_rep', name, req.user.email);
    res.status(201).json({ success: true, userId: newUserId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reps/:id/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { store_ids } = req.body;
    if (!store_ids || !Array.isArray(store_ids)) return res.status(400).json({ error: 'store_ids array required' });
    for (const sid of store_ids) {
      await q('INSERT INTO rep_store_assignments (rep_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DISTRIBUTOR ───────────────────────────────────────────────────────────────
app.get('/api/distributor/stores', authenticate, authorize('distributor'), async (req, res) => {
  try {
    res.json(await all(
      'SELECT s.* FROM stores s INNER JOIN distributor_stores ds ON ds.store_id=s.id WHERE ds.distributor_id=$1 ORDER BY s.name',
      [req.user.id]
    ));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
app.get('/api/products', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const products = await all('SELECT * FROM products WHERE active=1 ORDER BY name');
    const result = await Promise.all(products.map(async p => {
      const price = await getPriceForUser(p.id, userId, role);
      const allPrices = role === 'admin' ? await all('SELECT role,user_id,price FROM product_prices WHERE product_id=$1', [p.id]) : null;
      return { ...p, my_price: price, all_prices: allPrices };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/all', authenticate, authorize('admin'), async (req, res) => {
  try {
    const products = await all('SELECT * FROM products ORDER BY name');
    const result = await Promise.all(products.map(async p => {
      const prices = await all('SELECT role,user_id,price FROM product_prices WHERE product_id=$1 AND user_id IS NULL', [p.id]);
      return { ...p, role_prices: prices };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, image_url, sku, stock, prices } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });
    const p = await one(
      'INSERT INTO products (name,description,image_url,sku,stock) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, description||'', image_url||'', sku||'', stock||0]
    );
    if (prices) {
      for (const [role, price] of Object.entries(prices)) {
        if (price !== '' && price != null) {
          await q(
            'INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price',
            [p.id, role, parseFloat(price)]
          );
        }
      }
    }
    await logActivity('created_product', name, req.user.email);
    res.status(201).json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/products/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, image_url, sku, stock, active, prices } = req.body;
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const updated = await one(
      'UPDATE products SET name=$1,description=$2,image_url=$3,sku=$4,stock=$5,active=$6 WHERE id=$7 RETURNING *',
      [name??p.name, description??p.description, image_url??p.image_url, sku??p.sku, stock??p.stock, active??p.active, req.params.id]
    );
    if (prices) {
      for (const [role, price] of Object.entries(prices)) {
        if (price !== '' && price != null) {
          await q(
            'INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price',
            [req.params.id, role, parseFloat(price)]
          );
        }
      }
    }
    await logActivity('updated_product', name||p.name, req.user.email);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/products/:id/price', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { user_id, role, price } = req.body;
    if (!price) return res.status(400).json({ error: 'Price required' });
    if (user_id) {
      await q('INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,$2,NULL,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price', [req.params.id, user_id, parseFloat(price)]);
    } else if (role) {
      await q('INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price', [req.params.id, role, parseFloat(price)]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    await q('DELETE FROM products WHERE id=$1', [req.params.id]);
    await logActivity('deleted_product', p.name, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CART ──────────────────────────────────────────────────────────────────────
async function getOrCreateCart(userId, storeId = null) {
  let cart = storeId
    ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [userId, storeId])
    : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [userId]);
  if (!cart) {
    cart = await one('INSERT INTO carts (user_id,store_id) VALUES ($1,$2) RETURNING *', [userId, storeId]);
  }
  return cart;
}

async function getCartWithItems(cartId) {
  const cart = await one('SELECT * FROM carts WHERE id=$1', [cartId]);
  if (!cart) return null;
  const items = await all(
    'SELECT ci.*,p.name,p.image_url,p.sku,p.stock FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1',
    [cartId]
  );
  const total = items.reduce((a,i)=>a+parseFloat(i.price_at_add)*i.quantity,0);
  return { ...cart, items, total };
}

app.get('/api/cart', authenticate, async (req, res) => {
  try {
    const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
    const cart = await getOrCreateCart(req.user.id, storeId);
    res.json(await getCartWithItems(cart.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cart/add', authenticate, async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { product_id, quantity=1, store_id=null } = req.body;
    const product = await one('SELECT * FROM products WHERE id=$1 AND active=1', [product_id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const price = await getPriceForUser(product_id, userId, role);
    if (!price) return res.status(400).json({ error: 'No price set for your account' });
    const qty = Math.max(1, Math.min(product.stock, Math.floor(parseInt(quantity)||1)));
    if (product.stock < 1) return res.status(400).json({ error: 'Product is out of stock' });
    const cart = await getOrCreateCart(userId, store_id);
    const existing = await one('SELECT * FROM cart_items WHERE cart_id=$1 AND product_id=$2', [cart.id, product_id]);
    if (existing) {
      const newQty = Math.min(product.stock, existing.quantity+qty);
      await q('UPDATE cart_items SET quantity=$1 WHERE id=$2', [newQty, existing.id]);
    } else {
      await q('INSERT INTO cart_items (cart_id,product_id,quantity,price_at_add) VALUES ($1,$2,$3,$4)', [cart.id, product_id, qty, price]);
    }
    res.json(await getCartWithItems(cart.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/cart/item/:id', authenticate, async (req, res) => {
  try {
    const { quantity } = req.body;
    const item = await one('SELECT ci.*,c.user_id FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=$1', [req.params.id]);
    if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    if (quantity <= 0) { await q('DELETE FROM cart_items WHERE id=$1', [req.params.id]); }
    else { await q('UPDATE cart_items SET quantity=$1 WHERE id=$2', [quantity, req.params.id]); }
    res.json(await getCartWithItems(item.cart_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cart/item/:id', authenticate, async (req, res) => {
  try {
    const item = await one('SELECT ci.*,c.user_id FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=$1', [req.params.id]);
    if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    await q('DELETE FROM cart_items WHERE id=$1', [req.params.id]);
    res.json(await getCartWithItems(item.cart_id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cart', authenticate, async (req, res) => {
  try {
    const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
    const cart = storeId
      ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [req.user.id, storeId])
      : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [req.user.id]);
    if (cart) await q('DELETE FROM cart_items WHERE cart_id=$1', [cart.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
app.post('/api/orders', authenticate, async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { store_id, payment_method, shipping_name, shipping_address, shipping_city, shipping_state, shipping_zip, notes } = req.body;
    if (!payment_method) return res.status(400).json({ error: 'Payment method required' });
    if (!shipping_address || !shipping_city || !shipping_state || !shipping_zip) return res.status(400).json({ error: 'Complete shipping address required' });

    const cart = store_id
      ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [userId, store_id])
      : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [userId]);
    if (!cart) return res.status(400).json({ error: 'Cart not found' });

    const items = await all('SELECT ci.*,p.name,p.stock FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1', [cart.id]);
    if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
    for (const item of items) {
      if (item.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.name}` });
    }

    const subtotal = items.reduce((a,i)=>a+parseFloat(i.price_at_add)*i.quantity,0);
    const shipping_cost = subtotal > 500 ? 0 : 15;
    const total = subtotal + shipping_cost;
    const payment_status = payment_method === 'card' ? 'paid' : 'unpaid';

    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      const or = await client.query(
        `INSERT INTO orders (user_id,store_id,payment_method,payment_status,subtotal,shipping_cost,total,shipping_name,shipping_address,shipping_city,shipping_state,shipping_zip,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [userId, store_id||null, payment_method, payment_status, subtotal, shipping_cost, total,
         shipping_name||'', shipping_address, shipping_city, shipping_state, shipping_zip, notes||'']
      );
      order = or.rows[0];
      for (const item of items) {
        await client.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5)',
          [order.id, item.product_id, item.quantity, item.price_at_add, parseFloat(item.price_at_add)*item.quantity]);
        await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, item.product_id]);
      }
      await client.query('DELETE FROM cart_items WHERE cart_id=$1', [cart.id]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await logActivity('placed_order', `Order #${order.id}`, req.user.email);

    // Email notification
    const itemList = items.map(i => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${i.name}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">${i.quantity}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;text-align:right;">$${(parseFloat(i.price_at_add)*i.quantity).toFixed(2)}</td></tr>`).join('');
    await sendNotification(
      `🛒 New Order #${order.id} — $${parseFloat(order.total).toFixed(2)}`,
      `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="background:#2563eb;padding:24px 28px;">
          <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#93c5fd;">WowCow Distribution</p>
          <h1 style="margin:8px 0 0;font-size:22px;color:#ffffff;">New Order Received</h1>
        </div>
        <div style="padding:24px 28px;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Order #</td><td style="padding:6px 0;font-weight:700;font-size:13px;">#${order.id}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Placed by</td><td style="padding:6px 0;font-size:13px;">${req.user.email}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Payment</td><td style="padding:6px 0;font-size:13px;">${order.payment_method === 'invoice' ? 'Invoice / Net-30' : 'Credit Card'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Ship to</td><td style="padding:6px 0;font-size:13px;">${order.shipping_address}, ${order.shipping_city}, ${order.shipping_state} ${order.shipping_zip}</td></tr>
          </table>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;">Product</th><th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;">Qty</th><th style="padding:8px 12px;text-align:right;font-size:12px;color:#64748b;">Amount</th></tr></thead>
            <tbody>${itemList}</tbody>
          </table>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Subtotal</td><td style="padding:4px 0;text-align:right;font-size:13px;">$${parseFloat(order.subtotal).toFixed(2)}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Shipping</td><td style="padding:4px 0;text-align:right;font-size:13px;">${parseFloat(order.shipping_cost) === 0 ? 'FREE' : '$' + parseFloat(order.shipping_cost).toFixed(2)}</td></tr>
            <tr style="border-top:2px solid #e2e8f0;"><td style="padding:10px 0 0;font-weight:700;font-size:15px;">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:15px;color:#2563eb;">$${parseFloat(order.total).toFixed(2)}</td></tr>
          </table>
        </div>
        <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">Log in to your admin dashboard to manage this order.</div>
      </div>`
    );

    res.status(201).json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const orders = role === 'admin'
      ? await all('SELECT o.*,u.name as user_name,u.email as user_email,s.name as store_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC')
      : await all('SELECT o.*,s.name as store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id WHERE o.user_id=$1 ORDER BY o.created_at DESC', [userId]);
    const result = await Promise.all(orders.map(async o => {
      const items = await all('SELECT oi.*,p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1', [o.id]);
      return { ...o, items };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pending','processing','shipped','delivered','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const order = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await q('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);
    if (status === 'delivered' && order.status !== 'delivered' && order.store_id) {
      const items = await all('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
      for (const item of items) {
        await q(
          `INSERT INTO store_inventory (store_id,product_id,quantity,low_stock_threshold)
           VALUES ($1,$2,$3,10) ON CONFLICT (store_id,product_id) DO UPDATE SET quantity=store_inventory.quantity+EXCLUDED.quantity, updated_at=NOW()`,
          [order.store_id, item.product_id, item.quantity]
        );
      }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INVENTORY ─────────────────────────────────────────────────────────────────
app.get('/api/inventory/:store_id', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const storeId = parseInt(req.params.store_id);
    if (role === 'store_owner') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id !== storeId) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'distributor') {
      const assigned = await one('SELECT 1 FROM distributor_stores WHERE distributor_id=$1 AND store_id=$2', [userId, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (!rep) return res.status(403).json({ error: 'Access denied' });
      const assigned = await one('SELECT 1 FROM rep_store_assignments WHERE rep_id=$1 AND store_id=$2', [rep.id, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
    }
    const store = await one('SELECT * FROM stores WHERE id=$1', [storeId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const inventory = await all(
      'SELECT si.*,p.name as product_name,p.sku,p.image_url FROM store_inventory si JOIN products p ON p.id=si.product_id WHERE si.store_id=$1 ORDER BY si.quantity ASC',
      [storeId]
    );
    res.json({ store, inventory });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    let storeIds = [];
    if (role === 'store_owner') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id) storeIds = [user.store_id];
    } else if (role === 'distributor') {
      storeIds = (await all('SELECT store_id FROM distributor_stores WHERE distributor_id=$1', [userId])).map(r=>r.store_id);
    } else if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (rep) storeIds = (await all('SELECT store_id FROM rep_store_assignments WHERE rep_id=$1', [rep.id])).map(r=>r.store_id);
    } else if (role === 'admin') {
      storeIds = (await all('SELECT id FROM stores')).map(r=>r.id);
    }
    if (!storeIds.length) return res.json([]);
    const placeholders = storeIds.map((_,i)=>`$${i+1}`).join(',');
    res.json(await all(
      `SELECT s.id as store_id,s.name as store_name,s.city,s.state,
              p.id as product_id,p.name as product_name,p.sku,p.image_url,
              si.quantity,si.low_stock_threshold,
              CASE WHEN si.quantity<=si.low_stock_threshold THEN 1 ELSE 0 END as is_low
       FROM stores s
       INNER JOIN store_inventory si ON si.store_id=s.id
       INNER JOIN products p ON p.id=si.product_id
       WHERE s.id IN (${placeholders})
       ORDER BY is_low DESC, si.quantity ASC, s.name`,
      storeIds
    ));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/inventory/:store_id/:product_id', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const { quantity, low_stock_threshold } = req.body;
    const storeId = parseInt(req.params.store_id);
    if (role === 'store_owner') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id !== storeId) return res.status(403).json({ error: 'Access denied' });
    } else if (role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    await q(
      `INSERT INTO store_inventory (store_id,product_id,quantity,low_stock_threshold,updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (store_id,product_id) DO UPDATE SET
         quantity=COALESCE($3,store_inventory.quantity),
         low_stock_threshold=COALESCE($4,store_inventory.low_stock_threshold),
         updated_at=NOW()`,
      [storeId, req.params.product_id, quantity??null, low_stock_threshold??null]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`🐄 WowCow running on port ${PORT}`));
}).catch(err => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});
