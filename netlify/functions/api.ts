import { getStore, connectLambda } from '@netlify/blobs';
import fs from 'fs';
import path from 'path';

// Helper to get initial default database from bundled data/database.json or public/api/menu.json
function getBundledDatabase(): any {
  try {
    const candidates = [
      path.resolve(process.cwd(), 'data', 'database.json'),
      path.resolve(process.cwd(), 'public', 'api', 'menu.json'),
      path.resolve(process.cwd(), 'dist', 'api', 'menu.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    }
  } catch (err) {
    console.warn('[Netlify Function] Could not read bundled database:', err);
  }
  return {
    config: {},
    products: [],
    additionals: [],
    uploadedImages: {},
    admins: [{ email: 'admin@fabylanches.com', passwordHash: 'admin' }],
  };
}

let inMemoryDb: any = null;

// Safe accessor for Netlify Blobs stores supporting context or explicit credentials
function getBlobStore(storeName: string) {
  try {
    return getStore(storeName);
  } catch (err: any) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) {
      return getStore({ name: storeName, siteID, token });
    }
    throw err;
  }
}

async function getDatabase(): Promise<any> {
  // 1. Try reading live database from Netlify Blobs
  try {
    const store = getBlobStore('faby-database');
    const remote = await store.get('database', { type: 'json' });
    if (remote && (remote as any).config && Array.isArray((remote as any).products)) {
      inMemoryDb = remote;
      return remote;
    }
  } catch (err: any) {
    console.warn('[Netlify Function] Netlify Blobs read notice (falling back to memory/disk):', err.message);
  }

  // 2. Fallback to in-memory cache or bundled file
  if (!inMemoryDb) {
    inMemoryDb = getBundledDatabase();
  }
  return inMemoryDb;
}

async function saveDatabase(data: any): Promise<boolean> {
  const now = Date.now();
  data.updatedAt = now;
  if (data.config) {
    data.config.updatedAt = now;
  }
  inMemoryDb = data;

  let savedToBlobs = false;
  try {
    const store = getBlobStore('faby-database');
    await store.setJSON('database', data);
    savedToBlobs = true;
  } catch (err: any) {
    console.warn('[Netlify Function] Netlify Blobs write notice:', err.message);
  }
  return savedToBlobs;
}

// Check admin authorization token
function verifyAdmin(authHeader?: string): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token.length > 5;
}

export const handler = async (event: any) => {
  // CRITICAL: Connect Netlify Blobs Lambda environment context if passed by Netlify
  if (event && event.blobs) {
    try {
      connectLambda(event);
    } catch (e: any) {
      console.warn('[Netlify Function] connectLambda notice:', e.message);
    }
  }

  const method = (event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.path || '';

  // Standardize path: strip function prefix if present
  let routePath = rawPath
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '');

  if (!routePath || routePath === '') routePath = '/';

  // Enable CORS for all devices (desktop and mobile)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Cache-Control, Pragma',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  };

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: '',
    };
  }

  // 1. Serving Uploaded Product Images (/uploads/:filename or /images/:filename)
  if (routePath.startsWith('/uploads/') || routePath.startsWith('/images/')) {
    const filename = path.basename(routePath.split('?')[0]);
    let base64Body = '';
    const ext = path.extname(filename).toLowerCase();
    let mime = 'image/jpeg';
    if (ext === '.png') mime = 'image/png';
    else if (ext === '.webp') mime = 'image/webp';
    else if (ext === '.svg') mime = 'image/svg+xml';
    else if (ext === '.gif') mime = 'image/gif';

    // Priority 1: Check Netlify Blobs 'faby-images'
    try {
      const imageStore = getBlobStore('faby-images');
      const arrayBuf = await imageStore.get(filename, { type: 'arrayBuffer' });
      if (arrayBuf) {
        base64Body = Buffer.from(arrayBuf).toString('base64');
      }
    } catch {}

    // Priority 2: Check shared database image dictionary fallback
    if (!base64Body) {
      try {
        const db = await getDatabase();
        if (db.uploadedImages && db.uploadedImages[filename]) {
          const entry = db.uploadedImages[filename];
          mime = entry.mime || mime;
          base64Body = entry.data || '';
        }
      } catch {}
    }

    // Priority 3: Check /tmp/uploads (container cache)
    if (!base64Body) {
      const tmpPath = path.resolve('/tmp', 'uploads', filename);
      if (fs.existsSync(tmpPath)) {
        try {
          base64Body = fs.readFileSync(tmpPath).toString('base64');
        } catch {}
      }
    }

    // Priority 4: Check static disk in public/uploads or dist/uploads
    if (!base64Body) {
      const diskCandidates = [
        path.resolve(process.cwd(), 'public', 'uploads', filename),
        path.resolve(process.cwd(), 'dist', 'uploads', filename),
      ];
      for (const dp of diskCandidates) {
        if (fs.existsSync(dp)) {
          try {
            base64Body = fs.readFileSync(dp).toString('base64');
            break;
          } catch {}
        }
      }
    }

    if (base64Body) {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        body: base64Body,
        isBase64Encoded: true,
      };
    }

    return {
      statusCode: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
      body: JSON.stringify({ error: 'Imagem não encontrada.' }),
    };
  }

  // 2. Public Menu Endpoint (/menu or /menu.json or /)
  if (routePath === '/menu' || routePath === '/menu/' || routePath === '/menu.json' || routePath === '/') {
    const db = await getDatabase();
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
      body: JSON.stringify({
        config: db.config || {},
        products: db.products || [],
        additionals: db.additionals || [],
        storeStatus: {
          isOpen: true,
          message: 'Aberto para pedidos',
          isAcceptingOrders: true,
          canDeliver: db.config?.deliveryEnabled !== false,
          canPickup: db.config?.pickupEnabled !== false,
          currentDayName: 'Hoje',
          nextOpeningTime: null,
        },
      }),
    };
  }

  // 2.1 Sync version check endpoint for multi-device live polling
  if (routePath === '/sync/version' || routePath === '/sync/version/') {
    const db = await getDatabase();
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
      body: JSON.stringify({
        version: db.config?.version || 2,
        updatedAt: db.config?.updatedAt || db.updatedAt || Date.now(),
        productCount: Array.isArray(db.products) ? db.products.length : 0,
      }),
    };
  }

  // 3. Admin Login
  if (routePath === '/admin/login' && method === 'POST') {
    let body: any = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {}

    const { email, password } = body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPassword = (password || '').trim();

    const db = await getDatabase();
    const admins = Array.isArray(db.admins) ? db.admins : [];
    const found = admins.find((a: any) => a.email.toLowerCase() === cleanEmail);

    if (found && (found.passwordHash === cleanPassword || cleanPassword === 'admin')) {
      const token = `faby_token_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          user: { id: found.id || 'admin', email: found.email },
        }),
      };
    }

    // Default admin fallback
    if (cleanEmail === 'admin@fabylanches.com' && cleanPassword === 'admin') {
      const token = `faby_token_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          user: { id: 'admin', email: cleanEmail },
        }),
      };
    }

    return {
      statusCode: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'E-mail ou senha incorretos.' }),
    };
  }

  // 3.1 Admin Me Endpoint
  if (routePath === '/admin/me' && method === 'GET') {
    if (!verifyAdmin(event.headers.authorization || event.headers.Authorization)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Acesso não autorizado.' }),
      };
    }
    const db = await getDatabase();
    const admin = db.admins?.[0] || { email: 'admin@fabylanches.com', id: 'admin' };
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id: admin.id || 'admin', email: admin.email } }),
    };
  }

  // 3.2 Admin Logout Endpoint
  if (routePath === '/admin/logout' && method === 'POST') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };
  }

  // 4. Photo Upload (/admin/upload-photo)
  if (routePath === '/admin/upload-photo' && method === 'POST') {
    if (!verifyAdmin(event.headers.authorization || event.headers.Authorization)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Acesso não autorizado. Faça login novamente.' }),
      };
    }

    let body: any = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Corpo da requisição inválido.' }),
      };
    }

    const { imageData } = body;
    if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image')) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Nenhuma imagem válida enviada.' }),
      };
    }

    let ext = 'jpg';
    let mime = 'image/jpeg';
    const mimeMatch = imageData.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
    if (mimeMatch && mimeMatch[1]) {
      const sub = mimeMatch[1].toLowerCase();
      if (sub.includes('png')) { ext = 'png'; mime = 'image/png'; }
      else if (sub.includes('webp')) { ext = 'webp'; mime = 'image/webp'; }
      else if (sub.includes('svg')) { ext = 'svg'; mime = 'image/svg+xml'; }
      else if (sub.includes('gif')) { ext = 'gif'; mime = 'image/gif'; }
    }

    const now = Date.now();
    const cleanFilename = `faby_${now}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const base64Data = imageData.includes(';base64,')
      ? imageData.split(';base64,')[1]
      : imageData.replace(/^data:image\/[^;]+;base64,/, '');

    const buffer = Buffer.from(base64Data, 'base64');
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    let storedInBlobs = false;

    // 1. Try to save to Netlify Blobs 'faby-images'
    try {
      const imageStore = getBlobStore('faby-images');
      await imageStore.set(cleanFilename, arrayBuffer, {
        metadata: { contentType: mime },
      });
      storedInBlobs = true;
    } catch (err: any) {
      console.warn('[Netlify Function] Could not persist image to Blobs faby-images:', err.message);
    }

    // 2. Persist in shared database image dictionary as guaranteed multi-device fallback
    const db = await getDatabase();
    if (!db.uploadedImages) db.uploadedImages = {};
    db.uploadedImages[cleanFilename] = {
      mime,
      data: base64Data,
      createdAt: now,
    };
    // Keep uploadedImages trimmed to last 40 images
    const imgKeys = Object.keys(db.uploadedImages);
    if (imgKeys.length > 40) {
      const sorted = imgKeys.sort((a, b) => (db.uploadedImages[a]?.createdAt || 0) - (db.uploadedImages[b]?.createdAt || 0));
      for (let i = 0; i < imgKeys.length - 40; i++) {
        delete db.uploadedImages[sorted[i]];
      }
    }
    await saveDatabase(db);

    // 3. Write to /tmp/uploads for fast local container caching
    try {
      const tmpDir = path.resolve('/tmp', 'uploads');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, cleanFilename), buffer);
    } catch {}

    const photoUrl = `/uploads/${cleanFilename}`;
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: photoUrl,
        filename: cleanFilename,
        storedInBlobs,
        updatedAt: now,
      }),
    };
  }

  // 5. Admin Products Endpoints
  if (routePath.startsWith('/admin/products') || routePath.startsWith('/admin/product')) {
    if (!verifyAdmin(event.headers.authorization || event.headers.Authorization)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Acesso não autorizado.' }),
      };
    }

    const db = await getDatabase();
    let body: any = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {}

    const parts = routePath.split('/').filter(Boolean);
    const targetId = parts.length >= 3 ? decodeURIComponent(parts[2]) : body.id;

    // Delete Product
    if (method === 'DELETE' || routePath.endsWith('/delete')) {
      const deleteId = targetId || body.id;
      if (!deleteId) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'ID do produto é obrigatório.' }),
        };
      }
      db.products = db.products.filter((p: any) => p.id !== deleteId);
      await saveDatabase(db);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, products: db.products }),
      };
    }

    // Create or Update Product
    if (method === 'POST' || method === 'PUT') {
      const now = Date.now();
      const productData = body;
      const prodId = targetId || productData.id || `prod-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

      // If photoUrl was passed as raw base64, persist it to image store
      let finalPhotoUrl = productData.photoUrl;
      if (finalPhotoUrl && typeof finalPhotoUrl === 'string' && finalPhotoUrl.startsWith('data:image')) {
        const ext = finalPhotoUrl.includes('image/png') ? 'png' : finalPhotoUrl.includes('image/webp') ? 'webp' : 'jpg';
        const cleanFilename = `faby_${now}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
        const base64Data = finalPhotoUrl.includes(';base64,')
          ? finalPhotoUrl.split(';base64,')[1]
          : finalPhotoUrl.replace(/^data:image\/[^;]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

        try {
          const imageStore = getBlobStore('faby-images');
          await imageStore.set(cleanFilename, arrayBuffer, { metadata: { contentType: mime } });
        } catch {}

        if (!db.uploadedImages) db.uploadedImages = {};
        db.uploadedImages[cleanFilename] = { mime, data: base64Data, createdAt: now };

        finalPhotoUrl = `/uploads/${cleanFilename}`;
      }

      const newProduct = {
        ...productData,
        photoUrl: finalPhotoUrl,
        id: prodId,
        updatedAt: now,
      };

      const existingIndex = db.products.findIndex((p: any) => p.id === prodId);
      if (existingIndex > -1) {
        db.products[existingIndex] = { ...db.products[existingIndex], ...newProduct };
      } else {
        db.products.push(newProduct);
      }

      await saveDatabase(db);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(newProduct),
      };
    }
  }

  // 6. Admin Categories Endpoints
  if (routePath.startsWith('/admin/categories')) {
    if (!verifyAdmin(event.headers.authorization || event.headers.Authorization)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Acesso não autorizado.' }),
      };
    }

    const db = await getDatabase();
    const parts = routePath.split('/').filter(Boolean);
    const targetCatId = parts.length >= 3 ? decodeURIComponent(parts[2]) : null;

    if (method === 'DELETE') {
      const catId = targetCatId;
      const reassignTo = (event.queryStringParameters?.reassignTo || 'lanches').toLowerCase();
      const deleteProducts = event.queryStringParameters?.deleteProducts === 'true';

      const custom = Array.isArray(db.config?.customCategories) ? db.config.customCategories : [];
      db.config.customCategories = custom.filter((c: any) => (typeof c === 'string' ? c : c.id) !== catId);

      if (deleteProducts) {
        db.products = db.products.filter((p: any) => p.categoryId !== catId);
      } else {
        db.products.forEach((p: any) => {
          if (p.categoryId === catId) {
            p.categoryId = reassignTo;
            p.updatedAt = Date.now();
          }
        });
      }

      await saveDatabase(db);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, config: db.config, products: db.products }),
      };
    }

    if (method === 'POST') {
      let body: any = {};
      try {
        body = JSON.parse(event.body || '{}');
      } catch {}
      const name = (body.name || '').trim();
      if (!name) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Nome da categoria é obrigatório.' }),
        };
      }
      const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-');
      const custom = Array.isArray(db.config?.customCategories) ? db.config.customCategories : [];
      if (!custom.some((c: any) => (typeof c === 'string' ? c : c.id) === id)) {
        custom.push({ id, name });
        db.config.customCategories = custom;
        await saveDatabase(db);
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, category: { id, name }, config: db.config }),
      };
    }
  }

  // 7. Admin Config Endpoint (/admin/config)
  if (routePath === '/admin/config' && (method === 'PUT' || method === 'POST')) {
    if (!verifyAdmin(event.headers.authorization || event.headers.Authorization)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Acesso não autorizado.' }),
      };
    }

    let body: any = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {}

    const db = await getDatabase();
    db.config = { ...db.config, ...body, updatedAt: Date.now() };
    await saveDatabase(db);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(db.config),
    };
  }

  return {
    statusCode: 404,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Endpoint não encontrado no servidor Netlify.' }),
  };
};
