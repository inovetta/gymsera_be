require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
let swaggerSpec = {};
try {
  swaggerSpec = require('./src/config/swagger-config');
} catch (err) {
  console.warn('[Swagger] Failed to load swagger-config, using stub:', err.message);
}
const routes = require('./src/routes');
const errorHandler = require('./src/middleware/errorHandler');
const auditLog = require('./src/middleware/auditLog');
const appConfig = require('./src/config/app.config');

const app = express();

// ── Trust proxy (required on Vercel / any reverse-proxy host) ─────────────────
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// and req.ip returns the proxy IP instead of the real client IP.
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// CSP is relaxed for unpkg.com so the /api/docs Swagger UI can load from CDN.
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allow Flutter / mobile clients to load static assets
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
        styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://unpkg.com'],
        connectSrc: ["'self'", 'https://unpkg.com'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
  })
);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: appConfig.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-api-key'],
    credentials: true,
  })
);

// ── Static Files (Uploads) ───────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────────────────────────────
if (appConfig.nodeEnv !== 'test') {
  app.use(morgan(appConfig.nodeEnv === 'development' ? 'dev' : 'combined'));
}

// ── Rate limiting (applies to all /api routes) ────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 10000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

// ── Strict auth-route rate limiter (login/register/OTP) ──────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});
app.use('/api/v1/auth', authLimiter);

// ── Swagger docs ──────────────────────────────────────────────────────────────
// Custom CDN-based handler — avoids swagger-ui-express's express.static which
// returns text/html on Vercel (all routes go through the serverless function).
app.get('/api/docs/swagger.json', (_req, res) => res.json(swaggerSpec));
app.get(['/api/docs', '/api/docs/'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GymsEra API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: '/api/docs/swagger.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        deepLinking: true,
      });
    };
  </script>
</body>
</html>`);
});

// ── ZKTeco ADMS protocol — mounted at /iclock (no /api/v1 prefix) ────────────
// ZKTeco devices are configured with server URL: https://your-domain.com
// and ADMS path: /iclock  — the device appends /getrequest and /cdata itself.
// No rate-limiting or auth middleware here — the service validates by SN.
app.use('/iclock', require('./src/routes/iclock.routes'));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', auditLog);
app.use('/api/v1', routes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(errorHandler);

module.exports = app;
