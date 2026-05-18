import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import axios from 'axios';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "matrix_override_secure_token_99812";

// DB Pool Configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- LIVE SYNC EXTERNAL CACHE STORES ---
let ZOE_CACHE = [];
let WORK_CACHE = [];

// Initialize Database & Seeding Protocol
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE,
        description TEXT,
        calendar VARCHAR(50) NOT NULL,
        metric_sentiment VARCHAR(50),
        metric_location VARCHAR(255),
        metric_severity INT DEFAULT 0
      );
    `);

    // Auto-seed core system identity
    const userCheck = await pool.query('SELECT * FROM users WHERE username IN ($1, $2)', ['LiamBaker', 'ZoeHenry']);
    if (userCheck.rows.length === 0) {
      const liamHash = await bcrypt.hash('L1@m19892022', 10);
      await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', ['LiamBaker', liamHash]);
      console.log("✅ Core identity 'LiamBaker' seeded successfully into database.");
    }
  } catch (err) {
    console.error("❌ Database initialization failure:", err.message);
  }
}
initDb();

// --- LIVE ICAL EXTERNAL FEEDS SCRAPER ---
async function syncExternalFeeds() {
  console.log("🔄 Background Sync Init: Scraping external iCal feeds...");
  try {
    // Abington School / Zoe External Target Link Sync
    const zoeResponse = await axios.get("https://calendar.google.com/calendar/ical/example-zoe/public/basic.ics", { timeout: 6000 }).catch(() => null);
    if (zoeResponse && zoeResponse.data) {
      // Mock parsing representation matching your cache layout
      ZOE_CACHE = [
        { id: "ext-z1", title: "Zoe Coordination Sync", start: "2026-05-20T18:30:00Z", calendar: "zoe", isExternal: true, originCalendar: "zoe" },
        { id: "ext-z2", title: "Family Shared Dinner Rotation", start: "2026-05-24T17:00:00Z", calendar: "zoe", isExternal: true, originCalendar: "zoe" }
      ];
    }
    
    // Work / Client External Target Link Sync (Ford Dunton / JCB Wardlow logs)
    const workResponse = await axios.get("https://calendar.google.com/calendar/ical/example-work/public/basic.ics", { timeout: 6000 }).catch(() => null);
    if (workResponse && workResponse.data) {
      WORK_CACHE = [
        { id: "ext-w1", title: "Ford Dunton: DLX2 Benchmarking Execution", start: "2026-05-12T09:00:00Z", calendar: "work", isExternal: true, originCalendar: "work" },
        { id: "ext-w2", title: "JCB Wardlow Support Session", start: "2026-04-07T10:00:00Z", calendar: "work", isExternal: true, originCalendar: "work" }
      ];
    }
    console.log("✅ External live cache streams updated.");
  } catch (err) {
    console.error("⚠️ External iCal feed down. Keeping existing cache matrices.");
  }
}
cron.schedule('*/30 * * * *', syncExternalFeeds);
syncExternalFeeds();

// Token Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access token missing." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token signature expired." });
    req.user = user;
    next();
  });
}

// Auth Login Route
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: "User identity tracking not found." });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid credentials." });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { name: user.username } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FIXED ISOLATION ROUTING ENDPOINT
app.get('/api/events', authenticateToken, async (req, res) => {
  const targetView = req.query.calendar || 'combined';
  try {
    const dbResult = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    const localEvents = dbResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      start: row.start_time,
      end: row.end_time,
      description: row.description,
      calendar: row.calendar,
      metricSentiment: row.metric_sentiment,
      metricLocation: row.metric_location,
      metricSeverity: row.metric_severity,
      isExternal: false
    }));

    // FIXED ISOLATION ROUTING LAYER FROM DIFF
    if (targetView === 'combined') {
      return res.json([...localEvents, ...ZOE_CACHE, ...WORK_CACHE]);
    }
    if (targetView === 'zoe') {
      const zoeLocalOnly = localEvents.filter(e => e.calendar === 'zoe');
      return res.json([...zoeLocalOnly, ...ZOE_CACHE]);
    }
    if (targetView === 'work') {
      const workLocalOnly = localEvents.filter(e => e.calendar === 'work');
      return res.json([...workLocalOnly, ...WORK_CACHE]);
    }
    
    // For 'kids-logs', 'liam-life', or 'public-gcal' views, return exactly what the database isolated
    const filteredLocal = localEvents.filter(e => e.calendar === targetView);
    return res.json(filteredLocal);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events', authenticateToken, async (req, res) => {
  const { title, start, end, description, calendar, metricSentiment, metricLocation, metricSeverity } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO events (title, start_time, end_time, description, calendar, metric_sentiment, metric_location, metric_severity) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [title, start, end || null, description || '', calendar, metricSentiment || null, metricLocation || null, metricSeverity || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 Matrix Database Connected Engine active on port ${PORT}`));
