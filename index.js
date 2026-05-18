import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import dotenv from 'dotenv';
import ical from 'node-ical';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_MATRIX_SECRET_KEY_999!';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Memory Cache Arrays for Live Stream Synchronization
let ZOE_CACHE = [];
let WORK_CACHE = [];
let SCHOOL_CACHE = [];

// Automated Database Sync Engine
const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      start_time TIMESTAMP WITH TIME ZONE NOT NULL,
      end_time TIMESTAMP WITH TIME ZONE,
      description TEXT,
      calendar VARCHAR(50) DEFAULT 'combined',
      metric_sentiment VARCHAR(50), 
      metric_location VARCHAR(50),   
      metric_severity INT DEFAULT 0  
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_learning_states (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL, 
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const userCheck = await pool.query('SELECT * FROM users WHERE username IN ($1, $2)', ['LiamBaker', 'ZoeHenry']);
  if (userCheck.rows.length === 0) {
    const liamHash = await bcrypt.hash('L1@m19892022', 10);
    const zoeHash = await bcrypt.hash('password123', 10);

    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', ['LiamBaker', liamHash, 'admin']);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', ['ZoeHenry', zoeHash, 'user']);
    console.log("System Security Roles seeded successfully.");
  }
  console.log("Database infrastructure synchronized.");
};
initDb().catch(console.error);

// AUTHENTICATION MIDDLEWARES
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access token omitted." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token signature validation failed." });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: "Administrative clearance level required." });
  }
};

// LIVE FEED CRON SYNCHRONIZERS
const syncZoeFeed = async () => {
  if (!process.env.ICAL_URL_ZOE) return;
  try {
    const data = await ical.async.fromURL(process.env.ICAL_URL_ZOE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    const stateResult = await pool.query('SELECT event_id FROM event_learning_states WHERE status = $1', ['blocked']);
    const blockedIds = new Set(stateResult.rows.map(r => r.event_id));

    ZOE_CACHE = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start && !blockedIds.has(e.uid))
      .filter(e => { const s = new Date(e.start); return s >= startWindow && s <= endWindow; })
      .map(e => ({
        id: e.uid, title: e.summary || "Zoe Event",
        start: new Date(e.start).toISOString(), end: e.end ? new Date(e.end).toISOString() : null,
        description: e.description || '', color: '#f43f5e', calendar: 'zoe', isExternal: true, originCalendar: 'zoe'
      }));
  } catch (err) { console.error("Zoe iCal Sync Failure:", err.message); }
};

const syncWorkFeed = async () => {
  if (!process.env.ICAL_URL_WORK) return;
  try {
    const data = await ical.async.fromURL(process.env.ICAL_URL_WORK, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    const stateResult = await pool.query('SELECT event_id FROM event_learning_states WHERE status = $1', ['blocked']);
    const blockedIds = new Set(stateResult.rows.map(r => r.event_id));

    WORK_CACHE = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start && !blockedIds.has(e.uid))
      .filter(e => { const s = new Date(e.start); return s >= startWindow && s <= endWindow; })
      .map(e => {
        let title = e.summary || "Work Event";
        if (e['X-MICROSOFT-CDO-BUSYSTATUS'] === 'TENTATIVE' || String(e.description).includes('Tentative')) title = `⏳ [Tentative] ${title}`;
        return {
          id: e.uid, title, start: new Date(e.start).toISOString(), end: e.end ? new Date(e.end).toISOString() : null,
          description: e.description || '', color: '#818cf8', calendar: 'work', isExternal: true, originCalendar: 'work'
        };
      });
  } catch (err) { console.error("Work iCal Sync Failure:", err.message); }
};

const syncSchoolFeed = async () => {
  try {
    const schoolUrl = "https://calendar.google.com/calendar/ical/c_ca05bb6f1b85733a8038889ae52245021dcf5f1253116eb7c88dd45745fa5965%40group.calendar.google.com/public/basic.ics";
    const data = await ical.async.fromURL(schoolUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 12, 0);

    SCHOOL_CACHE = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start)
      .filter(e => { 
        const s = new Date(e.start); 
        return s >= startWindow && s <= endWindow; 
      })
      .map(e => ({
        id: e.uid || Math.random().toString(36).substr(2, 9),
        title: e.summary || 'School Event',
        start: new Date(e.start).toISOString(),
        end: e.end ? new Date(e.end).toISOString() : null,
        description: e.description || '',
        calendar: 'school', 
        color: '#0284c7',
        isExternal: true,
        originCalendar: 'school'
      }));
    console.log(`Abington School GCal Cached Natively: ${SCHOOL_CACHE.length} items.`);
  } catch (err) {
    console.error("School GCal Sync Failure:", err.message);
  }
};

const runAllSyncs = async () => { 
  await syncZoeFeed(); 
  await syncWorkFeed(); 
  await syncSchoolFeed(); 
};
runAllSyncs();
setInterval(runAllSyncs, 5 * 60 * 1000);

// API AUTH ROUTING ENDPOINTS
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials." });

    const user = result.rows[0];
    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) return res.status(401).json({ error: "Invalid credentials." });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CALENDAR SYSTEM MATRIX DISPATCHER
app.get('/api/events', authenticateToken, async (req, res) => {
  const targetView = req.query.calendar || 'combined';
  try {
    const dbResult = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    
    const localEvents = dbResult.rows.map(row => ({
      id: String(row.id), 
      title: row.title,
      start: new Date(row.start_time).toISOString(), 
      end: row.end_time ? new Date(row.end_time).toISOString() : null,
      description: row.description || '', 
      calendar: row.calendar || 'combined', 
      isExternal: false,
      color: row.calendar === 'zoe' ? '#f43f5e' : row.calendar === 'work' ? '#818cf8' : row.calendar === 'school' ? '#0284c7' : row.calendar === 'liam-life' ? '#f59e0b' : row.calendar === 'kids-logs' ? '#ec4899' : '#10b981',
      metricSentiment: row.metric_sentiment, 
      metricLocation: row.metric_location, 
      metricSeverity: row.metric_severity
    }));

    if (targetView === 'school') {
      const manualSchool = localEvents.filter(e => e.calendar === 'school');
      return res.json([...manualSchool, ...SCHOOL_CACHE].sort((a, b) => new Date(a.start) - new Date(b.start)));
    }

    if (targetView === 'zoe') {
      const manualZoe = localEvents.filter(e => e.calendar === 'zoe');
      return res.json([...manualZoe, ...ZOE_CACHE].sort((a, b) => new Date(a.start) - new Date(b.start)));
    }

    if (targetView === 'work') {
      const manualWork = localEvents.filter(e => e.calendar === 'work');
      return res.json([...manualWork, ...WORK_CACHE].sort((a, b) => new Date(a.start) - new Date(b.start)));
    }

    if (targetView === 'liam-life') {
      const liamLifeEvents = localEvents.filter(e => e.calendar === 'liam-life');
      return res.json(liamLifeEvents.sort((a, b) => new Date(a.start) - new Date(b.start)));
    }

    // MASTER COMBINED VIEW - Delivers everything cleanly to Frontend Tab Splitter
    const masterPool = [...localEvents, ...ZOE_CACHE, ...WORK_CACHE, ...SCHOOL_CACHE];

    if (targetView === 'combined') {
      return res.json(masterPool.sort((a, b) => new Date(a.start) - new Date(b.start)));
    }

    const dynamicSlice = masterPool
      .filter(event => String(event.calendar).toLowerCase() === String(targetView).toLowerCase())
      .sort((a, b) => new Date(a.start) - new Date(b.start));
      
    return res.json(dynamicSlice);

  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events', authenticateToken, async (req, res) => {
  const { title, start, end, description, calendar, metricSentiment, metricLocation, metricSeverity } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO events (title, start_time, end_time, description, calendar, metric_sentiment, metric_location, metric_severity) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, 
      [title, start, end || null, description || '', calendar || 'combined', metricSentiment || null, metricLocation || null, metricSeverity ? parseInt(metricSeverity) : 0]
    );
    res.json({ success: true, event: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OVERHAULED INTEGRATED ROUTER: Handles both Adding and Removing 
app.post('/api/events/route', authenticateToken, async (req, res) => {
  const { eventId, title, start, end, description, targetCalendar, isExternal } = req.body;
  try {
    // Inserts cloned event explicitly assigned to Liam's Life
    await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5)', 
      [title, start, end || null, description, targetCalendar]
    );
    
    // If it was sourced from an external iCal stream (Work/Zoe), block the original item from cluttering the ecosystem
    if (isExternal && eventId) {
      await pool.query(
        'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status', 
        [eventId, 'blocked']
      );
    }
    
    await runAllSyncs();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FIXED LEARNING/CLEANUP AGENT: Drops records when dropped from Liam's Life
app.post('/api/events/learn', authenticateToken, async (req, res) => {
  const { eventId, status } = req.body;
  try {
    // 1. Log structural learning block
    await pool.query(
      'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status', 
      [eventId, status]
    );
    
    // 2. ABSOLUTELY ESSENTIAL: Remove the clone from the events collection table
    if (status === 'blocked') {
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    
    await runAllSyncs();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ADMIN PANEL DATA STRIPS
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [username, hashed, role || 'user']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Execution anomaly. User may already exist." }); }
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Self-termination blocked." });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Secure Infrastructure engine active on port ${PORT}`));
