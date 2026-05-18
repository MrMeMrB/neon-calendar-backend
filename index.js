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

let memoryCache = { zoe: [], work: [], family: [] };

const initDb = async () => {
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

  console.log("PostgreSQL Database Architecture Operational.");
};
initDb().catch(console.error);

const fetchExternalCalendar = async (url, domainName, defaultColor) => {
  if (!url) return [];
  try {
    const data = await ical.async.fromURL(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
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
      .map(event => {
        let title = event.summary || "Untitled Event";
        
        const isTentative = event['X-MICROSOFT-CDO-BUSYSTATUS'] === 'TENTATIVE' || 
                            String(event.description).includes('Tentative');
        if (isTentative && domainName === 'work') {
          title = `⏳ [Tentative] ${title}`;
        }

        return {
          id: event.uid,
          title: title,
          start: new Date(event.start).toISOString(),
          end: event.end ? new Date(event.end).toISOString() : null,
          description: event.description || '',
          color: defaultColor,
          calendar: domainName,
          isExternal: true
        };
      });
  } catch (err) {
    console.error(`iCal Parser drop for ${domainName}:`, err.message);
    return [];
  }
};

const updateAllCalendarsCache = async () => {
  try {
    if (process.env.ICAL_URL_ZOE) memoryCache.zoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, 'zoe', '#f43f5e');
    if (process.env.ICAL_URL_WORK) memoryCache.work = await fetchExternalCalendar(process.env.ICAL_URL_WORK, 'work', '#818cf8');
    if (process.env.ICAL_URL_FAMILY) memoryCache.family = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, 'family', '#f59e0b');
    console.log("External memory cache segments updated.");
  } catch (err) { console.error("Cache sync failed:", err); }
};

updateAllCalendarsCache();
setInterval(updateAllCalendarsCache, 5 * 60 * 1000);

// FIX: Rigid context distribution logic applied here
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
      start: new Date(row.start_time).toISOString(),
      end: row.end_time ? new Date(row.end_time).toISOString() : null,
      description: row.description || '',
      calendar: row.calendar || 'combined',
      isExternal: false,
      color: row.calendar === 'zoe' ? '#f43f5e' : 
             row.calendar === 'work' ? '#818cf8' : 
             row.calendar === 'liam-life' ? '#00f0ff' : 
             row.calendar === 'kids-logs' ? '#ec4899' : '#10b981',
      metricSentiment: row.metric_sentiment,
      metricLocation: row.metric_location,
      metricSeverity: row.metric_severity
    }));

    // 1. COMBINED: Show everything together
    if (targetView === 'combined') {
      return res.json([
        ...localEvents,
        ...memoryCache.zoe,
        ...memoryCache.work,
        ...memoryCache.family
      ]);
    }

    // 2. ZOE CALENDAR: Only DB items tagged 'zoe' + raw Google Calendar feed
    if (targetView === 'zoe') {
      return res.json([...localEvents, ...memoryCache.zoe]);
    }

    // 3. WORK CALENDAR: Only DB items tagged 'work' + Outlook feed (including Tentatives)
    if (targetView === 'work') {
      return res.json([...localEvents, ...memoryCache.work]);
    }

    // 4. LIAM'S LIFE & KIDS LOGS: Strictly local DB events only, no external feed data mixed in
    return res.json(localEvents);

  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/events/route', async (req, res) => {
  const { eventId, title, start, end, description, targetCalendar, isExternal } = req.body;
  try {
    await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5)',
      [title, start, end || null, description, targetCalendar]
    );

    if (isExternal) {
      await pool.query(
        'INSERT INTO event_learning_states (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO UPDATE SET status = EXCLUDED.status',
        [eventId, 'blocked']
      );
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
  const { title, start, end, description, calendar, metricSentiment, metricLocation, metricSeverity } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO events 
       (title, start_time, end_time, description, calendar, metric_sentiment, metric_location, metric_severity) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, 
      [title, start, end || null, description || '', calendar || 'combined', metricSentiment || null, metricLocation || null, metricSeverity ? parseInt(metricSeverity) : 0]
    );
    res.json({ success: true, event: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Routing Server operational on port ${PORT}`));
