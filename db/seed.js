// Runs automatically on first boot if no users exist
// Can also be run manually: node db/seed.js

const { Pool } = require('pg');
const { faker } = require('@faker-js/faker');
const bcrypt = require('bcryptjs');

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    console.log('🌱 Seeding database...');

    // ── Stores ────────────────────────────────────────────────────────────────
    const categories = ['Electronics','Clothing','Grocery','Hardware','Sporting Goods','Pet Supplies','Home Decor','Beauty','Auto Parts','Books','Toys','Jewelry','Pharmacy','Furniture','Garden'];
    const statuses = ['active','active','active','active','active','active','active','pending','pending','inactive'];

    const storeIds = [];
    for (let i = 0; i < 200; i++) {
      const name = faker.company.name() + ' ' + faker.helpers.arrayElement(['Store','Shop','Outlet','Market','Supply']);
      const wholesale = Math.round(faker.number.float({ min:5, max:80 }) * 100) / 100;
      const retail = Math.round((wholesale * faker.number.float({ min:1.3, max:2.5 })) * 100) / 100;
      const distCost = Math.round(faker.number.float({ min:0.5, max:15 }) * 100) / 100;
      const r = await client.query(
        `INSERT INTO stores (name,owner_name,email,address,city,state,zip,category,monthly_revenue,wholesale_price,retail_price,distribution_cost,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [name, faker.person.fullName(), faker.internet.email().toLowerCase(),
         faker.location.streetAddress(), faker.location.city(), faker.location.state({ abbreviated:true }),
         faker.location.zipCode('#####'), faker.helpers.arrayElement(categories),
         Math.round(faker.number.float({ min:5000, max:500000 }) * 100)/100,
         wholesale, retail, distCost, faker.helpers.arrayElement(statuses)]
      );
      storeIds.push(r.rows[0].id);
    }
    console.log(`  ✓ ${storeIds.length} stores`);

    // ── Users ─────────────────────────────────────────────────────────────────
    const hash = pw => bcrypt.hashSync(pw, 10);
    const adminR  = await client.query(`INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ('admin@wowcow.com',$1,'admin','Admin User','555-0100','active') RETURNING id`, [hash('admin123')]);
    const invR    = await client.query(`INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ('investor@wowcow.com',$1,'investor','Investor User','555-0101','active') RETURNING id`, [hash('investor123')]);
    const ownerR  = await client.query(`INSERT INTO users (email,password_hash,role,store_id,name,phone,status) VALUES ('owner@store1.com',$1,'store_owner',$2,'Store Owner One','555-0102','active') RETURNING id`, [hash('owner123'), storeIds[0]]);
    const distR   = await client.query(`INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ('dist@wowcow.com',$1,'distributor','Distributor Demo','555-0103','active') RETURNING id`, [hash('dist123')]);
    const repR    = await client.query(`INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ('rep@wowcow.com',$1,'rep','Rep Demo','555-0104','active') RETURNING id`, [hash('rep123')]);

    const ownerId = ownerR.rows[0].id;
    const distId  = distR.rows[0].id;
    const repUserId = repR.rows[0].id;

    await client.query('INSERT INTO owner_stores (owner_id,store_id) VALUES ($1,$2)', [ownerId, storeIds[0]]);
    for (let i = 0; i < 20; i++) await client.query('INSERT INTO distributor_stores (distributor_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [distId, storeIds[i]]);

    const repRecord = await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,NULL,0.10) RETURNING id', [repUserId]);
    const repId = repRecord.rows[0].id;
    for (let i = 0; i < 10; i++) await client.query('INSERT INTO rep_store_assignments (rep_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [repId, storeIds[i]]);
    console.log('  ✓ 5 demo users');

    // ── Activity log ──────────────────────────────────────────────────────────
    const actions = ['created','updated','deleted','status_changed'];
    for (let i = 14; i >= 0; i--) {
      const date = new Date(); date.setHours(date.getHours() - i * 3);
      await client.query('INSERT INTO activity_log (action,target_name,user_email,created_at) VALUES ($1,$2,$3,$4)',
        [faker.helpers.arrayElement(actions), faker.company.name(), 'admin@wowcow.com', date.toISOString()]);
    }

    // ── Store notes ───────────────────────────────────────────────────────────
    const noteTexts = ['Great location, high foot traffic.','Owner requested quarterly review.','Revenue trending upward.','Needs follow-up on inventory.','New competitor opened nearby.'];
    for (let i = 0; i < 5; i++) {
      const date = new Date(); date.setDate(date.getDate() - (5-i));
      await client.query('INSERT INTO store_notes (store_id,note,created_at) VALUES ($1,$2,$3)', [storeIds[i], noteTexts[i], date.toISOString()]);
    }

    // ── Products ──────────────────────────────────────────────────────────────
    const products = [
      { name:'ADDY Focus Capsules 15ct',      description:'Clinically studied whole green coffee powder (WGCP) capsules. Sustained focus with no crash. High-impulse checkout sell.',          sku:'ADDY-CAP-15',  stock:500, image_url:'https://images.unsplash.com/photo-1550572017-ea93494b8b54?w=400', prices:{ store_owner:8.50,  distributor:7.00,  rep:7.50,  master_distributor:6.00  } },
      { name:'ADDY Focus Capsules 60ct',      description:'Full-size bottle for repeat customers. Same WGCP formula, better per-unit margin. Strong re-order velocity.',                       sku:'ADDY-CAP-60',  stock:400, image_url:'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=400', prices:{ store_owner:28.00, distributor:23.00, rep:25.00, master_distributor:20.00 } },
      { name:'ADDY Energy Shot Blue Razz',    description:'Single-serve Blue Raspberry energy shot. All-natural, no crash. Ideal near registers and cooler doors.',                             sku:'ADDY-SHOT-BR', stock:600, image_url:'https://images.unsplash.com/photo-1622543925917-763c34d1a86e?w=400', prices:{ store_owner:3.50,  distributor:2.80,  rep:3.00,  master_distributor:2.40  } },
      { name:'ADDY Energy Shot Strawberry',   description:'Single-serve Strawberry energy shot. Same clean ADDY formula — the brand your customers already know.',                             sku:'ADDY-SHOT-SW', stock:600, image_url:'https://images.unsplash.com/photo-1534353436294-0dbd4bdac845?w=400', prices:{ store_owner:3.50,  distributor:2.80,  rep:3.00,  master_distributor:2.40  } },
      { name:'ADDY Energy Gummies',           description:'Chewable energy and focus gummies. No-pill format with strong crossover appeal. Expanding customer reach.',                          sku:'ADDY-GUM-01',  stock:350, image_url:'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?w=400', prices:{ store_owner:9.00,  distributor:7.50,  rep:8.00,  master_distributor:6.50  } },
    ];

    const productIds = [];
    for (const p of products) {
      const pr = await client.query(
        'INSERT INTO products (name,description,image_url,sku,stock,active) VALUES ($1,$2,$3,$4,$5,1) RETURNING id',
        [p.name, p.description, p.image_url, p.sku, p.stock]
      );
      const pid = pr.rows[0].id;
      productIds.push(pid);
      for (const [role, price] of Object.entries(p.prices)) {
        await client.query(
          'INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price',
          [pid, role, price]
        );
      }
    }
    console.log('  ✓ 6 products with tier pricing');

    // ── Store Inventory ───────────────────────────────────────────────────────
    const firstStores = storeIds.slice(0, 30);
    for (const sid of firstStores) {
      for (const pid of productIds) {
        await client.query(
          'INSERT INTO store_inventory (store_id,product_id,quantity,low_stock_threshold) VALUES ($1,$2,$3,10) ON CONFLICT DO NOTHING',
          [sid, pid, Math.floor(Math.random() * 120)]
        );
      }
    }
    console.log('  ✓ Store inventory seeded');

    console.log('\n✅ Seed complete!');
    console.log('  Admin:       admin@wowcow.com / admin123');
    console.log('  Investor:    investor@wowcow.com / investor123');
    console.log('  Wholesaler:  owner@store1.com / owner123');
    console.log('  Distributor: dist@wowcow.com / dist123');
    console.log('  Rep:         rep@wowcow.com / rep123');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error('❌ Seed failed:', err.message); process.exit(1); });
