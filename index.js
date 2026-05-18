import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import multer from 'multer';
import ical from 'node-ical';
import { GoogleGenAI } from '@google/generative-ai';
import cron from 'node-cron';

const { Pool } = pkg;
const storage = multer.memoryStorage();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Initialize Remote Persistent Neon PostgreSQL Database Instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Gemini Core AI Engine
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Safeguard DB schemas
async function bootstrapDatabaseStructure() {
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
    console.log('Successfully initialized Neon PostgreSQL schema structures.');
  } catch (err) {
    console.error('Error bootstrapping database tables:', err.message);
  }
}
bootstrapDatabaseStructure();

// Helper to normalize strings into safe ISO formats
function normalizeToISO(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    return !isNaN(parsed.getTime()) ? parsed.toISOString() : dateStr;
  } catch (e) {
    return dateStr;
  }
}

/* ==========================================
   LIVE EXTERNAL ICAL TO DATABASE SYNC ENGINE
   ========================================== */
async function syncExternalCalendars() {
  console.log("Starting master synchronization routine with external iCal vectors...");
  
  const sources = [
    { url: process.env.ICAL_URL_WORK, defaultDomain: 'work' },
    { url: process.env.ICAL_URL_ZOE, defaultDomain: 'family' }
  ];

  for (const source of sources) {
    if (!source.url) continue;

    try {
      const webEvents = await ical.fromURL(source.url);
      
      for (const k in webEvents) {
        if (webEvents.hasOwnProperty(k)) {
          const ev = webEvents[k];
          if (ev.type !== 'VEVENT') continue;

          const title = ev.summary || "Untitled Subscription Event";
          const start = ev.start ? new Date(ev.start).toISOString() : null;
          const end = ev.end ? new Date(ev.end).toISOString() : null;
          const desc = ev.description || "";
          const uid = ev.uid || `${title}-${start}`;

          if (!start) continue;

          // AI Intelligence Mapping Check
          let determinedCalendar = source.defaultDomain;
          let sentiment = 'neutral';
          let isUnverified = 0;

          // If it's Zoe's calendar, parse via Gemini to see if it belongs to kid logging profiles
          if (source.defaultDomain === 'family' && process.env.GEMINI_API_KEY) {
            try {
              const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
              const prompt = `Analyze this calendar item: Title: "${title}". Description: "${desc}". Is this related to children's activities, school updates, or kids behavior monitoring? Respond strictly in valid JSON format with keys: "isKidLog" (boolean), "sentiment" ("positive", "negative", or "neutral").`;
              
              const aiResult = await model.generateContent(prompt);
              const cleanedText = aiResult.response.text().replace(/```json|```/g, "").trim();
              const analysis = JSON.parse(cleanedText);

              if (analysis.isKidLog) {
                determinedCalendar = 'kids-logs';
                sentiment = analysis.sentiment || 'neutral';
                isUnverified = 1; // Mark for review in your sidebar panel!
              }
            } catch (aiErr) {
              console.error("Gemini context triage bypassed:", aiErr.message);
            }
          }

          // Insert or update entries gracefully using conflict exclusions
          const query = `
            INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment, uid)
            VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
            ON CONFLICT (uid) DO UPDATE SET
              title = EXCLUDED.title,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              description = EXCLUDED.description
          `;
          await pool.query(query, [title, start, end, desc, determinedCalendar, isUnverified, sentiment, uid]);
        }
      }
    } catch (err) {
      console.error(`Error syncing calendar source line:`, err.message);
    }
  }
  console.log("External sync routine execution successfully committed.");
}

// Manually trigger calendar feed ingestion
app.post('/api/sync-external', async (req, res) => {
  try {
    await syncExternalCalendars();
    res.json({ success: true, message: "Calendar synchronization loops completed successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run automatically every 30 minutes to capture timeline additions completely hands-free
cron.schedule('*/30 * * * *', () => {
  syncExternalCalendars();
});

/* ==========================================
   2. STANDARD INTERACTION ENDPOINTS
   ========================================== */

app.get('/api/events', async (req, res) => {
  const { calendar } = req.query;
  let query = 'SELECT id, title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment FROM events';
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = $1";
    params.push(calendar);
  }
  query += " ORDER BY start_time ASC";

  try {
    const result = await pool.query(query, params);
    const processed = result.rows.map(r => ({
      id: r.id,
      title: r.title,
      start: normalizeToISO(r.start_time),
      end: r.end_time ? normalizeToISO(r.end_time) : null,
      description: r.description || "",
      calendar: r.calendar || 'combined',
      isUnverified: r.is_unverified === 1 || !!r.is_unverified,
      isExternal: r.is_external === 1 || !!r.is_external,
      sentiment: r.sentiment || 'neutral'
    }));
    res.json(processed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar, sentiment } = req.body;
  const targetCal = calendar || 'combined';
  const targetSentiment = sentiment || 'neutral';
  const query = `INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment, uid) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7) RETURNING id`;
  try {
    const uniqueId = `manual-${new Date().getTime()}`;
    const result = await pool.query(query, [title, start, end || null, description || "", targetCal, targetSentiment, uniqueId]);
    res.json({ success: true, eventId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body;
  try {
    if (status === 'blocked') {
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
      res.json({ success: true, action: "purged" });
    } else if (status === 'verified_kid') {
      await pool.query("UPDATE events SET is_unverified = 0, calendar = 'family' WHERE id = $1", [eventId]);
      res.json({ success: true, action: "re-routed" });
    } else {
      res.status(400).json({ error: "Unknown instructional state type." });
    }
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
  const { content } = req.body;
  try {
    await pool.query(`INSERT INTO general_notes (id, content) VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content`, [content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server executing active matrix routing layers on port: ${PORT}`);
});
