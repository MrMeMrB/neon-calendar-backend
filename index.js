import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import multer from 'multer';

const { Pool } = pkg;
const storage = multer.memoryStorage();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB Limit max

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Initialize Remote Persistent Neon PostgreSQL Database Instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Safely verify database setup and structure
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
        sentiment TEXT DEFAULT 'neutral'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_notes (
        event_id INTEGER PRIMARY KEY,
        notes TEXT
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

// Helper function to force dates into clean ISO format FullCalendar accepts
function normalizeToISO(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return dateStr; // Fallback if it's already a specialized string
  } catch (e) {
    return dateStr;
  }
}

/* ==========================================
   1. CORE CALENDAR DATA LOGISTICS
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
    
    const processed = result.rows.map(r => {
      // Force normalization so the frontend timeline engines can read them cleanly
      const validStart = normalizeToISO(r.start_time);
      const validEnd = r.end_time ? normalizeToISO(r.end_time) : null;

      return {
        id: r.id,
        title: r.title,
        start: validStart,
        end: validEnd,
        description: r.description || "",
        calendar: r.calendar || 'combined',
        isUnverified: r.is_unverified === 1 || !!r.is_unverified,
        isExternal: r.is_external === 1 || !!r.is_external,
        sentiment: r.sentiment || 'neutral'
      };
    });
    
    res.json(processed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar, sentiment } = req.body;
  const targetCal = calendar || 'combined';
  const targetSentiment = sentiment || 'neutral';

  const query = `
    INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment) 
    VALUES ($1, $2, $3, $4, $5, 0, 0, $6) RETURNING id
  `;
  
  try {
    const result = await pool.query(query, [title, start, end || null, description || "", targetCal, targetSentiment]);
    res.json({ success: true, eventId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   2. VERIFICATION AND SEAMLESS ENGINE ENDPOINTS
   ========================================== */

app.post('/api/events/route-clone', async (req, res) => {
  const { title, start, end, description, targetCalendar, isExternal } = req.body;
  if (!title || !start || !targetCalendar) {
    return res.status(400).json({ error: "Missing identity tracking definitions." });
  }
  const query = `
    INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment)
    VALUES ($1, $2, $3, $4, $5, 0, $6, 'neutral') RETURNING id
  `;
  try {
    const result = await pool.query(query, [title, start, end || null, description || "", targetCalendar, isExternal ? 1 : 0]);
    res.json({ success: true, clonedId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body;
  if (!eventId) return res.status(400).json({ error: "Target structural context undefined." });

  try {
    if (status === 'blocked') {
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
      res.json({ success: true, action: "purged" });
    } else if (status === 'verified_kid') {
      await pool.query("UPDATE events SET is_unverified = 0, calendar = 'family' WHERE id = $1", [eventId]);
      res.json({ success: true, action: "re-routed" });
    } else {
      res.status(400).json({ error: "Unknown instructional vector state type." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   3. NOTES & GENERAL SCRATCHPAD STORAGE
   ========================================== */

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
  const query = `
    INSERT INTO general_notes (id, content) VALUES (1, $1) 
    ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content
  `;
  try {
    await pool.query(query, [content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Production Server listening on port: ${PORT}`);
});
