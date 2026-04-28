require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const { initFirebase }                   = require('../config/firebase');
const { generalLimiter }                 = require('./middleware/rateLimiter');
const logger                             = require('./utils/logger');
const healthRouter         = require('./routes/health');
const gamificationRouter   = require('./routes/gamification');
const agoraRouter          = require('./routes/agora');
const paystackRouter       = require('./routes/paystack');
const liveRouter           = require('./routes/live');
const notificationsRouter  = require('./routes/notifications');
const cbtRouter            = require('./routes/cbt');
const adminRouter          = require('./routes/admin');
const usersRouter          = require('./routes/users');
const broadcastsRouter     = require('./routes/broadcasts');
const videosRouter         = require('./routes/videos');
const scheduleRouter       = require('./routes/schedule');
const settingsRouter       = require('./routes/settings');

initFirebase();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());

const ALLOWED_ORIGINS = [
  'https://nltc-online.vercel.app',   // production frontend
  'http://localhost:3000',             // local dev (CRA / other)
  'http://localhost:4000',
  'http://localhost:5173',             // Vite dev server
  'http://localhost:5174',             // Vite dev server (alt port)
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5500',            // VS Code Live Server
  // any extra origins from env (comma-separated)
  ...( process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(',').map(o=>o.trim()) : [] ),
];

app.use(cors({
  origin: (origin, cb) => {
    // allow server-to-server requests (no origin) and whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));
app.options('*', cors());

// Raw body for Paystack webhook
app.use((req,_res,next) => {
  if (req.path==='/api/paystack/webhook') {
    let data='';
    req.setEncoding('utf8');
    req.on('data',chunk=>{ data+=chunk; });
    req.on('end',()=>{ req.rawBody=data; try{req.body=JSON.parse(data);}catch(_){req.body={};} next(); });
  } else { next(); }
});

app.use(express.json({ limit:'1mb' }));
app.use(express.urlencoded({ extended:true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[iso]] :method :url :status :response-time ms'));
}

app.use('/api/', generalLimiter);
app.use('/api/health',         healthRouter);
app.use('/api/gamification',   gamificationRouter);
app.use('/api/agora',          agoraRouter);
app.use('/api/paystack',       paystackRouter);
app.use('/payment',            paystackRouter);  // Paystack callback redirect
app.use('/api/live',           liveRouter);
app.use('/api/notifications',  notificationsRouter);
app.use('/api/cbt',            cbtRouter);
app.use('/api/admin',          adminRouter);
app.use('/api/users',          usersRouter);
app.use('/api/broadcasts',     broadcastsRouter);
app.use('/api/videos',         videosRouter);
app.use('/api/schedule',       scheduleRouter);
app.use('/api/settings',      settingsRouter);

app.use((req,res) => res.status(404).json({ error:`Route not found: ${req.method} ${req.path}` }));

app.use((err,_req,res,_next) => {
  logger.error('Unhandled error', { message:err.message });
  res.status(500).json({ error:'Internal server error', message: process.env.NODE_ENV==='development' ? err.message : undefined });
});

app.listen(PORT, () => {
  logger.info('NLTC Backend started', { port:PORT, env:process.env.NODE_ENV||'development' });
});

module.exports = app;