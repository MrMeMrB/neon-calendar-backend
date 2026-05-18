import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import dotenv from 'dotenv';
import ical from 'node-ical';

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors({ origin: '*' }));
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
      start_time TIMESTAMP WITH TIME ZONE NOT NULL,
      end_time TIMESTAMP WITH TIME ZONE,
      description TEXT,
      calendar VARCHAR(50) DEFAULT 'combined'
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

const fetchExternalCalendar = async (url, domainName, defaultColor, applyZoeKidsFilter = false) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
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
        let title = event.summary || "Untitled Event";
        let color = defaultColor; 
        let isUnverified = false;
        let targetCalendar = domainName;

        if (applyZoeKidsFilter && status === 'unverified') {
          title = `❓ ${title}`;
          color = '#ffaa00'; 
          isUnverified = true;
          targetCalendar = 'kids-logs';
        }

        return {
          id: event.uid,
          title: title,
          start: new Date(event.start).toISOString(), // Normalized Time Frame Alignment
          end: event.end ? new Date(event.end).toISOString() : null,
          description: event.description || '',
          color: color,
          calendar: targetCalendar,
          isUnverified: isUnverified,
          isExternal: true
        };
      });
  } catch (err) {
    console.error(`iCal Parse error stream for ${domainName}:`, err.message);
    return [];
  }
};

const updateAllCalendarsCache = async () => {
  try {
    if (process.env.ICAL_URL_ZOE) memoryCache.zoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, 'zoe', '#f43f5e', true);
    if (process.env.ICAL_URL_WORK) memoryCache.work = await fetchExternalCalendar(process.env.ICAL_URL_WORK, 'work', '#818cf8');
    if (process.env.ICAL_URL_FAMILY) memoryCache.family = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, 'family', '#f59e0b');
  } catch (err) { console.error(err); }
};

updateAllCalendarsCache();
setInterval(updateAllCalendarsCache, 5 * 60 * 1000);

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
      start: new Date(row.start_time).toISOString(), // Normalized Time Frame Alignment
      end: row.end_time ? new Date(row.end_time).toISOString() : null,
      description: row.description || '',
      calendar: row.calendar || 'combined',
      isExternal: false,
      isUnverified: false,
      color: row.calendar === 'zoe' ? '#f43f5e' : 
             row.calendar === 'work' ? '#818cf8' : 
             row.calendar === 'family' ? '#f59e0b' : 
             row.calendar === 'kids-logs' ? '#ec4899' : '#10b981'
    }));

    const allExternal = [
      ...memoryCache.zoe,
      ...memoryCache.work,
      ...memoryCache.family
    ];

    if (targetView === 'combined') {
      return res.json([...localEvents, ...allExternal]);
    }

    if (targetView === 'kids-logs') {
      const externalKids = memoryCache.zoe.filter(e => e.calendar === 'kids-logs');
      return res.json([...localEvents, ...externalKids]);
    }

    const filteredExternal = allExternal.filter(e => e.calendar === targetView);
    return res.json([...localEvents, ...filteredExternal]);

  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ROUTE EXTERNAL SUBSCRIPTION ITEM INTO INTERNAL LOCAL DATABASE SCTOR
app.post('/api/events/route', async (req, res) => {
  const { eventId, title, start, end, description, targetCalendar, isExternal } = req.body;
  try {
    // 1. Inject static copy into internal PostgreSQL Table
    await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5)',
      [title.replace('❓ ', ''), start, end || null, description, targetCalendar]
    );

    // 2. Hide original stream element from memory views by marking it blocked
    if (isExternal) {
      await pool.query(
        'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status',
        [eventId, 'blocked']
      );
    }

    await updateAllCalendarsCache();
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// PURGE AND DISMISS WITHOUT SAVING ANY INTERNAL COPIES
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

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Routing Engine running on port ${PORT}`));
