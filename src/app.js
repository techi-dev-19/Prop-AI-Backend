const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const env = require('./config/env');
const routes = require('./routes');
const { apiLimiter } = require('./middlewares/rateLimit');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');

const app = express();

app.set('trust proxy', 1); // needed for correct IPs / secure cookies behind a proxy (Render, Nginx, etc.)

app.use(helmet());

// app.use(
//   cors({
//     origin: "*",
//   })
// );

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  })
);


// Keeps the raw request body around (req.rawBody) alongside the parsed
// req.body — needed to verify Meta's X-Hub-Signature-256 header on inbound
// WhatsApp webhook POSTs (see middlewares/verifyMetaSignature.js). Harmless
// for every other route; the buffer is just discarded if unused.
app.use(
  express.json({
    limit: '5mb', // 5000-lead bulk upload (campaign launch) ke liye
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(mongoSanitize()); // strips $/. operators from user input to block NoSQL injection
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(apiLimiter);

// Public sales images / brochures the WhatsApp agent sends. Meta's servers
// download these by URL, so they must be reachable without auth.
app.use(
  '/sales-media',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    next();
  },
  express.static(path.join(__dirname, '..', 'public', 'sales-media'), { fallthrough: false }),
);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
