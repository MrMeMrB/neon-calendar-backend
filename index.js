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

// Global cache storage
let memoryCache = {
  liam: [],
  zoe: [],
  work: [],
  family: []
};

// Case-insensitive keywords for filtering Zoe's stream
const KIDS_KEYWORDS = [
  'jasper', 'indie', 'jb', 'ib school', 'phonics', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 
  'parents', 'term', 'half term', 'summer holiday', 'holiday', 'haven', 'centre'
];

// Automatically initializes and upgrades database tables on server start
const initDb = async () => {
  // Core events table
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

  // Table to store user notes specifically pinned to a calendar event
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_notes (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      custom_notes TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Table to store the persistent global sidebar scratchpad content
  await pool.query(`
    CREATE TABLE IF NOT EXISTS general_notes (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("PostgreSQL Unified Schema initialized successfully.");
};
initDb().catch(console.error);

async function extractEventsWithAI(text) {
  const prompt = `
    Analyze this text and extract all calendar events, tasks, deadlines, or meetings.
    Return the output STRICTLY as a valid JSON array of objects using this exact format:
    [
      {
        "title": "Clear descriptive name for the event",
        "start": "YYYY-MM-DDTHH:MM:SS",
        "end": "YYYY-MM-DDTHH:MM:SS or null",
        "description": "Context clues or details extracted from text"
      }
    ]
    Rules: Current year is 2026. If no specific clock time is found, default to 09:00:00. Do not append markdown backticks.
    Text: ${text}
  `;

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return JSON.parse(response.text);
}

// ==========================================================
// TIME WINDOW FILTER & ICAL FETCH ENGINE (WITH ZOE KEYWORDS)
// ==========================================================
const fetchExternalCalendar = async (url, defaultColor, applyZoeKidsFilter = false) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url);
    
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1); // Start of last month
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);  // End of next month

    return Object.values(data)
      .filter(event => {
        if (event.type !== 'VEVENT' || !event.start) return false;
        
        // Window check
        const eventStart = new Date(event.start);
        const insideWindow = eventStart >= startWindow && eventStart <= endWindow;
        if (!insideWindow) return false;

        // If it's Zoe's stream, check text context against your requested keywords
        if (applyZoeKidsFilter) {
          const textPayload = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
          return KIDS_KEYWORDS.some(keyword => textPayload.includes(keyword));
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
    
    // Zoe's stream with critical keyword filtering enabled
    if (process.env.ICAL_URL_ZOE) memoryCache.zoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, '#f43f5e', true);
    
    // Liam's ATI Work stream (Outlook stream link configuration)
    if (process.env.ICAL_URL_WORK) memoryCache.work = await fetchExternalCalendar(process.env.ICAL_URL_WORK, '#818cf8');
    
    if (process.env.ICAL_URL_FAMILY) memoryCache.family = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, '#f59e0b');
    console.log("✅ Background sync complete. Cache warmed.");
  } catch (err) {
    console.error("Background sync failed:", err.message);
  }
};

updateAllCalendarsCache();
setInterval(updateAllCalendarsCache, 5 * 60 * 1000);

// ==========================================
// EVENTS DELIVER PIPELINE
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
      finalPayload = [
        ...finalPayload,
        ...memoryCache.liam,
        ...memoryCache.zoe,
        ...memoryCache.work,
        ...memoryCache.family
      ];
    } else if (targetView === 'liam') {
      finalPayload = [...finalPayload, ...memoryCache.liam];
    } else if (targetView === 'zoe') {
      finalPayload = [...finalPayload, ...memoryCache.zoe];
    } else if (targetView === 'work') {
      finalPayload = [...finalPayload, ...memoryCache.work];
    } else if (targetView === 'family') {
      finalPayload = [...finalPayload, ...memoryCache.family];
    }

    res.json(finalPayload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Commit Manual Events
app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, start, end || null, description || '', calendar || 'combined']
    );
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// NEW FEATURES: EVENT DETAILED NOTES ENDPOINTS
// ==========================================
app.get('/api/events/:id/notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT custom_notes FROM event_notes WHERE event_id = $1', [req.params.id]);
    res.json({ notes: result.rows[0]?.custom_notes || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/:id/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    await pool.query(
      `INSERT INTO event_notes (event_id, custom_notes) VALUES ($1, $2)
       ON CONFLICT (event_id) DO UPDATE SET custom_notes = EXCLUDED.custom_notes`,
      [req.params.id, notes]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// NEW FEATURES: GLOBAL SCRATCHPAD ENDPOINTS
// ==========================================
app.get('/api/general-notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT content FROM general_notes ORDER BY id DESC LIMIT 1');
    res.json({ content: result.rows[0]?.content || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/general-notes', async (req, res) => {
  const { content } = req.body;
  try {
    await pool.query('INSERT INTO general_notes (content) VALUES ($1)', [content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Document parsing utilities
app.post('/api/upload-document', express.raw({ type: 'application/pdf', limit: '10mb' }), async (req, res) => {
  try {
    const parsedPdf = await pdfParse(req.body);
    const events = await extractEventsWithAI(parsedPdf.text);
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-url', async (req, res) => {
  const { fileUrl } = req.body;
  if (!fileUrl) return res.status(400).json({ error: "No link submitted" });
  try {
    const response = await fetch(fileUrl);
    const arrayBuffer = await response.arrayBuffer();
    const parsedPdf = await pdfParse(Buffer.from(arrayBuffer));
    const events = await extractEventsWithAI(parsedPdf.text);
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
