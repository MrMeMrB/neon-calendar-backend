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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_learning_states (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL, 
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("PostgreSQL Target Routing Engine Schema Initialized.");
};
initDb().catch(console.error);

const fetchExternalCalendar = async (url, defaultColor, applyZoeKidsFilter = false) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url);
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    const stateResult = await pool.query('SELECT event_id, status FROM event_learning_states');
    const stateMap = new Map(stateResult.rows.map(r => [r.event_id, r.status]));

    return Object.values(data)
      .filter(event => {
        if (event.type !== 'VEVENT' || !event.start) return false;
        if (stateMap.get(event.uid) === 'blocked') return false; 

        const eventStart = new Date(event.start);
        return eventStart >= startWindow && eventStart <= endWindow;
      })
      .filter(event => {
        if (!applyZoeKidsFilter) return true;
        if (stateMap.get(event.uid) === 'verified_kid') return true;

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
          color = '#4b5563'; 
          isUnverified = true;
        }

        return {
          id: event.uid,
          title: title,
          start: event.start,
          end: event.end,
          description: event.description || '',
          color: color,
          isUnverified: isUnverified,
          isExternal: true // Flag to know if it originates from an live feed
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

// STRICT CATEGORY VIEWS FILTERING
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
      isExternal: false,
      color: row.calendar === 'zoe' ? '#f43f5e' : row.calendar === 'work' ? '#818cf8' : row.calendar === 'family' ? '#f59e0b' : row.calendar === 'kids-logs' ? '#ec4899' : '#10b981'
    }));

    let finalPayload = [...localEvents];
    
    // Strict separation alignment logic: Only mix feeds into exact destinations
    if (targetView === 'combined') {
      finalPayload = [...finalPayload, ...memoryCache.liam, ...memoryCache.zoe, ...memoryCache.work, ...memoryCache.family];
    } else if (targetView === 'liam') {
      finalPayload = [...finalPayload, ...memoryCache.liam];
    } else if (targetView === 'zoe') {
      // Everything from Zoe's raw feed lives exclusively here unless sorted out
      finalPayload = [...finalPayload, ...memoryCache.zoe];
    } else if (targetView === 'work') {
      finalPayload = [...finalPayload, ...memoryCache.work];
    } else if (targetView === 'family') {
      finalPayload = [...finalPayload, ...memoryCache.family];
    }

    res.json(finalPayload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ROUTING MANEUVER: Transfers an event to another bucket
app.post('/api/events/route', async (req, res) => {
  const { eventId, title, start, end, description, targetCalendar, isExternal } = req.body;
  try {
    if (isExternal) {
      // 1. Write as a permanent local record under your target scope
      await pool.query(
        'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5)',
        [title.replace('❓ ', ''), start, end || null, description, targetCalendar]
      );
      // 2. Add to external learning suppression map so it disappears from the original automated feed
      await pool.query(
        'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status',
        [eventId, 'blocked']
      );
    } else {
      // If it's already a local entry, simply modify its current target destination column
      await pool.query('UPDATE events SET calendar = $1 WHERE id = $2', [targetCalendar, eventId]);
    }

    await updateAllCalendarsCache();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body; 
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
    res.json({ content: result.rows[0]?.content || "" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/general-notes', async (req, res) => {
  try {
    await pool.query('INSERT INTO general_notes (content) VALUES ($1)', [req.body.content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Routing Engine running on port ${PORT}`));
