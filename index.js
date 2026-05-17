import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import pdfParse from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import ical from 'node-ical';

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let memoryCache = { liam: [], zoe: [], work: [], family: [] };

// Whole-word matching list
const KIDS_KEYWORDS = [
  'jasper', 'indie', 'jb', 'ib school', 'phonics', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 
  'parents', 'term', 'half term', 'summer holiday', 'holiday', 'haven', 'centre'
];

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP,
      description TEXT,
      calendar VARCHAR(50) DEFAULT 'combined'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_notes (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      custom_notes TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS general_notes (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // NEW TABLE: Stores unique IDs of manually filtered-out iCal entries
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_events (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      blocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("PostgreSQL Unified Schema + Learning Filters initialized.");
};
initDb().catch(console.error);

const fetchExternalCalendar = async (url, defaultColor, applyZoeKidsFilter = false) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url);
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    // Fetch currently blocked IDs from the DB to skip them immediately
    const blockedResult = await pool.query('SELECT event_id FROM blocked_events');
    const blockedIds = new Set(blockedResult.rows.map(r => r.event_id));

    return Object.values(data)
      .filter(event => {
        if (event.type !== 'VEVENT' || !event.start) return false;
        if (blockedIds.has(event.uid)) return false; // Skip if user hidden it previously
        
        const eventStart = new Date(event.start);
        const insideWindow = eventStart >= startWindow && eventStart <= endWindow;
        if (!insideWindow) return false;

        if (applyZoeKidsFilter) {
          const textPayload = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
          
          // Enhanced strict boundary matching (prevents "CJB" matching "JB")
          return KIDS_KEYWORDS.some(keyword => {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            return regex.test(textPayload);
          });
        }

        return true;
      })
      .map(event => ({
        id: event.uid,
        title: event.summary,
        start: event.start,
        end: event.end,
        description: event.description || '',
        color: defaultColor
      }));
  } catch (err) {
    console.error(`Error parsing link stream: ${url.substring(0, 30)}...`, err.message);
    return [];
  }
};

const updateAllCalendarsCache = async () => {
  console.log("⚡ Starting background sync of external calendar streams...");
  try {
    if (process.env.ICAL_URL_LIAM) memoryCache.liam = await fetchExternalCalendar(process.env.ICAL_URL_LIAM, '#10b981');
    if (process.env.ICAL_URL_ZOE) memoryCache.zoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, '#f43f5e', true);
    if (process.env.ICAL_URL_WORK) memoryCache.work = await fetchExternalCalendar(process.env.ICAL_URL_WORK, '#818cf8');
    if (process.env.ICAL_URL_FAMILY) memoryCache.family = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, '#f59e0b');
    console.log("✅ Background sync complete.");
  } catch (err) {
    console.error("Background sync failed:", err.message);
  }
};

updateAllCalendarsCache();
setInterval(updateAllCalendarsCache, 5 * 60 * 1000);

// ==========================================
// ENDPOINTS
// ==========================================
app.get('/api/events', async (req, res) => {
  const targetView = req.query.calendar || 'combined';
  try {
    let dbResult;
    if (targetView === 'combined') {
      dbResult = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    } else {
      dbResult = await pool.query('SELECT * FROM events WHERE calendar = $1 ORDER BY start_time ASC', [targetView]);
    }

    const localEvents = dbResult.rows.map(row => ({
      id: String(row.id),
      title: row.title,
      start: row.start_time,
      end: row.end_time,
      description: row.description,
      calendar: row.calendar,
      color: row.calendar === 'zoe' ? '#f43f5e' : row.calendar === 'work' ? '#818cf8' : row.calendar === 'family' ? '#f59e0b' : row.calendar === 'kids-logs' ? '#ec4899' : '#38bdf8'
    }));

    let finalPayload = [...localEvents];

    if (targetView === 'combined') {
      finalPayload = [...finalPayload, ...memoryCache.liam, ...memoryCache.zoe, ...memoryCache.work, ...memoryCache.family];
    } else if (targetView === 'liam') finalPayload = [...finalPayload, ...memoryCache.liam];
    else if (targetView === 'zoe') finalPayload = [...finalPayload, ...memoryCache.zoe];
    else if (targetView === 'work') finalPayload = [...finalPayload, ...memoryCache.work];
    else if (targetView === 'family') finalPayload = [...finalPayload, ...memoryCache.family];

    res.json(finalPayload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEW PIPELINE: Add event to blocklist and force a stream filter cache refresh
app.post('/api/events/block', async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: "Missing Target Event ID" });
  try {
    await pool.query('INSERT INTO blocked_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    await updateAllCalendarsCache(); // Recalculate working sets
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, start, end || null, description || '', calendar || 'combined']
    );
    res.json({ success: true, event: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events/:id/notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT custom_notes FROM event_notes WHERE event_id = $1', [req.params.id]);
    res.json({ notes: result.rows[0]?.custom_notes || "" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    await pool.query(
      `INSERT INTO event_notes (event_id, custom_notes) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET custom_notes = EXCLUDED.custom_notes`,
      [req.params.id, notes]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/general-notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT content FROM general_notes ORDER BY id DESC LIMIT 1');
    res.json({ content: result.rows[0]?.content || "" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/general-notes', async (req, res) => {
  const { content } = req.body;
  try {
    await pool.query('INSERT INTO general_notes (content) VALUES ($1)', [content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
