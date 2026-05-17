import express from 'express';
import cors from 'cors';
import pkg from 'pg';
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

let memoryCache = { liam: [], zoe: [], work: [], family: [] };

// Softer keyword set to catch potential matches
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

  // Unified learning table tracking manual validation states
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_learning_states (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL, -- 'verified_kid', 'blocked'
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("PostgreSQL Learning Engine Schema Initialized.");
};
initDb().catch(console.error);

const fetchExternalCalendar = async (url, defaultColor, applyZoeKidsFilter = false) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url);
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    // Pull learning records
    const stateResult = await pool.query('SELECT event_id, status FROM event_learning_states');
    const stateMap = new Map(stateResult.rows.map(r => [r.event_id, r.status]));

    return Object.values(data)
      .filter(event => {
        if (event.type !== 'VEVENT' || !event.start) return false;
        if (stateMap.get(event.uid) === 'blocked') return false; // Hard hide if blocked

        const eventStart = new Date(event.start);
        return eventStart >= startWindow && eventStart <= endWindow;
      })
      .filter(event => {
        // If not Zoe's stream, let everything pass
        if (!applyZoeKidsFilter) return true;

        // If explicitly approved before, let it pass
        if (stateMap.get(event.uid) === 'verified_kid') return true;

        // Run soft keyword matching
        const textPayload = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
        return KIDS_KEYWORDS.some(keyword => textPayload.includes(keyword));
      })
      .map(event => {
        const status = stateMap.get(event.uid) || 'unverified';
        let title = event.summary;
        let color = defaultColor;
        let isUnverified = false;

        if (applyZoeKidsFilter && status === 'unverified') {
          title = `❓ ${title}`;
          color = '#4b5563'; // Muted dark slate gray for unverified items
          isUnverified = true;
        }

        return {
          id: event.uid,
          title: title,
          start: event.start,
          end: event.end,
          description: event.description || '',
          color: color,
          isUnverified: isUnverified
        };
      });
  } catch (err) {
    console.error("iCal Parse error stream:", err.message);
    return [];
  }
};

const updateAllCalendarsCache = async () => {
  try {
    if (process.env.ICAL_URL_LIAM) memoryCache.liam = await fetchExternalCalendar(process.env.ICAL_URL_LIAM, '#10b981');
    if (process.env.ICAL_URL_ZOE) memoryCache.zoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, '#f43f5e', true);
    if (process.env.ICAL_URL_WORK) memoryCache.work = await fetchExternalCalendar(process.env.ICAL_URL_WORK, '#818cf8');
    if (process.env.ICAL_URL_FAMILY) memoryCache.family = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, '#f59e0b');
  } catch (err) { console.error(err); }
};

updateAllCalendarsCache();
setInterval(updateAllCalendarsCache, 5 * 60 * 1000);

// ENDPOINTS
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
    if (targetView === 'combined') finalPayload = [...finalPayload, ...memoryCache.liam, ...memoryCache.zoe, ...memoryCache.work, ...memoryCache.family];
    else if (targetView === 'liam') finalPayload = [...finalPayload, ...memoryCache.liam];
    else if (targetView === 'zoe') finalPayload = [...finalPayload, ...memoryCache.zoe];
    else if (targetView === 'work') finalPayload = [...finalPayload, ...memoryCache.work];
    else if (targetView === 'family') finalPayload = [...finalPayload, ...memoryCache.family];

    res.json(finalPayload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update the learning status of an external stream item
app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body; // status can be 'verified_kid' or 'blocked'
  try {
    await pool.query(
      'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status',
      [eventId, status]
    );
    await updateAllCalendarsCache();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar } = req.body;
  try {
    const result = await pool.query('INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5) RETURNING *', [title, start, end || null, description || '', calendar || 'combined']);
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
    await pool.query('INSERT INTO event_notes (event_id, custom_notes) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET custom_notes = EXCLUDED.custom_notes', [req.params.id, notes]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/general-notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT content FROM general_notes ORDER BY id DESC LIMIT 1');
    res.json({ content: r.rows[0]?.content || "" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/general-notes', async (req, res) => {
  try {
    await pool.query('INSERT INTO general_notes (content) VALUES ($1)', [req.body.content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Backend engine running on port ${PORT}`));
