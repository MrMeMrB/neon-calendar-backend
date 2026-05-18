import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import ical from 'node-ical';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 5001;

// Global Middleware Configuration
app.use(cors({ origin: '*' }));
app.use(express.json());

// Initialize Persistent Neon PostgreSQL Database Instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Gemini Core AI Engine
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ==========================================================================
   1. DATABASE SCHEMA AUTOMATION & BOOTSTRAPPING
   ========================================================================== */
async function bootstrapDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        description TEXT,
        calendar TEXT DEFAULT 'combined',
        is_unverified INTEGER DEFAULT 0,
        is_external INTEGER DEFAULT 1,
        sentiment TEXT DEFAULT 'neutral',
        uid TEXT UNIQUE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS general_notes (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT
      )
    `);
    console.log('🚀 Neon PostgreSQL Database schemas validated successfully.');
  } catch (err) {
    console.error('❌ Database bootstrapping failed:', err.message);
  }
}
bootstrapDatabase();

function normalizeToISO(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    return !isNaN(parsed.getTime()) ? parsed.toISOString() : dateStr;
  } catch (e) {
    return dateStr;
  }
}

/* ==========================================================================
   2. INTELLIGENT SYNCHRONIZATION PIPELINE
   ========================================================================== */
async function executeCalendarSync() {
  console.log("🔄 Initiating high-speed replication down external iCal assets...");
  const sources = [
    { url: process.env.ICAL_URL_WORK, domain: 'work' },
    { url: process.env.ICAL_URL_ZOE, domain: 'family' }
  ];

  for (const source of sources) {
    if (!source.url) {
      console.log(`⚠️ Missing URL variable for domain: ${source.domain}`);
      continue;
    }
    try {
      const webEvents = await ical.fromURL(source.url);
      for (const k in webEvents) {
        if (!webEvents.hasOwnProperty(k)) continue;
        const ev = webEvents[k];
        if (ev.type !== 'VEVENT') continue;

        const title = ev.summary || "Untitled Event Engine";
        const start = ev.start ? new Date(ev.start).toISOString() : null;
        const end = ev.end ? new Date(ev.end).toISOString() : null;
        const desc = ev.description || "";
        const uid = ev.uid || `ext-${title}-${start}`;

        if (!start) continue;

        let targetCalendar = source.domain;
        let sentiment = 'neutral';
        let isUnverified = 0;

        // Perform Deep AI Analysis on Zoe's Feed to Track Kids Log Exceptions
        if (source.domain === 'family' && process.env.GEMINI_API_KEY) {
          try {
            const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Analyze this entry: Title: "${title}". Desc: "${desc}". Is this linked to children's behavior, school logs, kids activities, or parenting tracking? Return strict JSON format with keys: "isKidLog" (boolean), "sentiment" ("positive", "negative", "neutral").`;
            const aiResult = await model.generateContent(prompt);
            const cleanText = aiResult.response.text().replace(/```json|```/g, "").trim();
            const payload = JSON.parse(cleanText);

            if (payload.isKidLog) {
              targetCalendar = 'kids-logs';
              sentiment = payload.sentiment || 'neutral';
              isUnverified = 1; 
            }
          } catch (e) {
            console.error("⚠️ AI categorization skipped:", e.message);
          }
        }

        const query = `
          INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment, uid)
          VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
          ON CONFLICT (uid) DO UPDATE SET
            title = EXCLUDED.title, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, description = EXCLUDED.description
        `;
        await pool.query(query, [title, start, end, desc, targetCalendar, isUnverified, sentiment, uid]);
      }
    } catch (err) {
      console.error(`❌ Sync line execution dropped on source:`, err.message);
    }
  }
  console.log("✅ Sync complete. Data matrix normalized inside Neon DB.");
}

// Automatically sync every 30 minutes in the background
cron.schedule('*/30 * * * *', () => executeCalendarSync());

/* ==========================================================================
   3. API ENDPOINTS
   ========================================================================== */

app.get('/api/events', async (req, res) => {
  const { calendar } = req.query;
  let query = 'SELECT * FROM events';
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = $1";
    params.push(calendar);
  }
  query += " ORDER BY start_time ASC";

  try {
    const result = await pool.query(query, params);
    const data = result.rows.map(r => ({
      id: r.id,
      title: r.title,
      start: normalizeToISO(r.start_time),
      end: r.end_time ? normalizeToISO(r.end_time) : null,
      description: r.description || "",
      calendar: r.calendar || 'combined',
      isUnverified: r.is_unverified === 1,
      isExternal: r.is_external === 1,
      sentiment: r.sentiment || 'neutral',
      uid: r.uid
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar, sentiment } = req.body;
  try {
    const uid = `manual-${Date.now()}`;
    await pool.query(
      `INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment, uid) 
       VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7)`,
      [title, start, end || null, description || "", calendar || 'combined', sentiment || 'neutral', uid]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body;
  try {
    if (status === 'blocked') {
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    } else if (status === 'verified_kid') {
      await pool.query("UPDATE events SET is_unverified = 0, calendar = 'family' WHERE id = $1", [eventId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync-external', async (req, res) => {
  try {
    await executeCalendarSync();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/general-notes', async (req, res) => {
  try {
    const result = await pool.query("SELECT content FROM general_notes WHERE id = 1");
    res.json({ content: result.rows[0] ? result.rows[0].content : "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/general-notes', async (req, res) => {
  try {
    await pool.query(`INSERT INTO general_notes (id, content) VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content`, [req.body.content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ API Service Active on port: ${PORT}`);
});
