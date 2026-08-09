require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 25);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!API_KEY || API_KEY === 'change-me-to-a-long-random-string') {
  console.error('FATAL: Set a real API_KEY in your .env file before starting the server.');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', true);
app.use(morgan('combined'));

const corsOptions = {
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
};
app.use(cors(corsOptions));

// ---- Optionally serve the PWA front-end from this same server ----
// Set SERVE_STATIC=false in .env if you're hosting the pwa/ folder separately (e.g. IIS).
const SERVE_STATIC = (process.env.SERVE_STATIC || 'true').toLowerCase() !== 'false';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'pwa'));
if (SERVE_STATIC && fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  console.log(`Serving PWA static files from: ${STATIC_DIR}`);
}

// ---- Auth: accepts "Authorization: Bearer <key>" OR "?key=<key>" / "?api_key=<key>" ----
function checkAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearerMatch = header.match(/^Bearer\s+(.+)$/i);
  const headerKey = bearerMatch ? bearerMatch[1].trim() : null;
  const queryKey = (req.query.key || req.query.api_key || '').toString().trim();
  const presented = headerKey || queryKey;

  if (!presented) {
    return res.status(401).json({ error: 'Missing API key. Provide it as "Authorization: Bearer <key>" or "?key=<key>".' });
  }

  // Constant-time comparison to avoid timing side-channels.
  const a = Buffer.from(presented);
  const b = Buffer.from(API_KEY);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  next();
}

// ---- Helpers ----
function sanitizeSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function dateStamp(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const EXT_BY_MIME = {
  'image/jpeg':      '.jpg',
  'image/png':       '.png',
  'image/webp':      '.webp',
  'image/heic':      '.heic',
  'image/heif':      '.heif',
  'image/gif':       '.gif',
  'application/pdf': '.pdf',
};

// ---- Multer: dynamic destination = UPLOAD_DIR/<employeeId>/<YYYY-MM-DD>/ ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const employeeId = sanitizeSegment(req.body.employeeId, 'unknown_employee');
    const dir = path.join(UPLOAD_DIR, employeeId, dateStamp());
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname) || '.jpg';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(4).toString('hex');
    const employeeId = sanitizeSegment(req.body.employeeId, 'unknown_employee');
    cb(null, `${employeeId}_${ts}_${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
      return cb(new Error('Only image files and PDFs are accepted.'));
    }
    cb(null, true);
  },
});

// Config fingerprint — a hash of the things that matter to the client.
// Changes whenever the API key rotates, the upload dir changes, or the server restarts.
// The client polls this; if the hash changes it knows to prompt the user to refresh settings.
const CONFIG_HASH = crypto
  .createHash('sha256')
  .update(`${API_KEY}:${UPLOAD_DIR}:${Date.now()}`)
  .digest('hex')
  .slice(0, 16);

app.get('/api/health', checkAuth, (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Intentionally unauthenticated — clients need to detect a config change even
// before they know the new key. The hash reveals nothing about the key itself.
app.get('/api/version', (req, res) => {
  res.json({ configHash: CONFIG_HASH });
});

app.post('/api/upload', checkAuth, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Max size is ${MAX_FILE_MB}MB.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file received. Field name must be "photo".' });
    }

    const employeeId = sanitizeSegment(req.body.employeeId, 'unknown_employee');
    res.json({
      ok: true,
      employeeId,
      savedAs:     path.relative(UPLOAD_DIR, req.file.path),
      size:        req.file.size,
      mimeType:    req.file.mimetype,
      uploadedAt:  new Date().toISOString(),
    });
  });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Photo upload server listening on port ${PORT}`);
  console.log(`Saving uploads under: ${UPLOAD_DIR}`);
});
