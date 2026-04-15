require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const { initFirebase }                   = require('../config/firebase');
const { generalLimiter }                 = require('./middleware/rateLimiter');
const logger                             = require('./utils/logger');
const healthRouter       = require('./routes/health');
const gamificationRouter = require('./routes/gamification');
const agoraRouter        = require('./routes/agora');
const paystackRouter     = require('./routes/paystack');

initFirebase();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(o=>o.trim()),
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

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
app.use('/api/health',       healthRouter);
app.use('/api/gamification', gamificationRouter);
app.use('/api/agora',        agoraRouter);
app.use('/api/paystack',     paystackRouter);
app.use('/payment',          paystackRouter); // serves /payment/callback redirect from Paystack

app.use((req,res) => res.status(404).json({ error:`Route not found: ${req.method} ${req.path}` }));

app.use((err,_req,res,_next) => {
  logger.error('Unhandled error', { message:err.message });
  res.status(500).json({ error:'Internal server error', message: process.env.NODE_ENV==='development' ? err.message : undefined });
});

app.listen(PORT, () => {
  logger.info('NLTC Backend started', { port:PORT, env:process.env.NODE_ENV||'development' });
});

module.exports = app;