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

// Walled-off, completely independent cache arrays
let ZOE_CACHE = [];
let WORK_CACHE = [];

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
  console.log("Database initialized.");
};
initDb().catch(console.error);

// 1. STRIKT ZOE PARSER (Google Calendar Feed)
const syncZoeFeed = async () => {
  if (!process.env.ICAL_URL_ZOE) return;
  try {
    const data = await ical.async.fromURL(process.env.ICAL_URL_ZOE, {
      headers: { 'User-Agent': 'Mozilla' }
    });
    
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    const stateResult = await pool.query('SELECT event_id FROM event_learning_states WHERE status = $1', ['blocked']);
    const blockedIds = new Set(stateResult.rows.map(r => r.event_id));

    ZOE_CACHE = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start && !blockedIds.has(e.uid))
      .filter(e => {
        const s = new Date(e.start);
        return s >= startWindow && s <= endWindow;
      })
      .map(e => ({
        id: e.uid,
        title: e.summary || "Zoe Event",
        start: new Date(e.start).toISOString(),
        end: e.end ? new Date(e.end).toISOString() : null,
        description: e.description || '',
        color: '#f43f5e',
        calendar: 'zoe',
        isExternal: true
      }));
    console.log(`Zoe Cache reloaded. Total: ${ZOE_CACHE.length}`);
  } catch (err) {
    console.error("Zoe sync failed:", err.message);
  }
};

// 2. STRIKT WORK PARSER (Outlook Calendar Feed)
const syncWorkFeed = async () => {
  if (!process.env.ICAL_URL_WORK) return;
  try {
    const data = await ical.async.fromURL(process.env.ICAL_URL_WORK, {
      headers: { 'User-Agent': 'Mozilla' }
    });
    
    const now = new Date();
    const startWindow = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endWindow = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    const stateResult = await pool.query('SELECT event_id FROM event_learning_states WHERE status = $1', ['blocked']);
    const blockedIds = new Set(stateResult.rows.map(r => r.event_id));

    WORK_CACHE = Object.values(data)
      .filter(e => e.type === 'VEVENT' && e.start && !blockedIds.has(e.uid))
      .filter(e => {
        const s = new Date(e.start);
        return s >= startWindow && s <= endWindow;
      })
      .map(e => {
        let title = e.summary || "Work Event";
        const isTentative = e['X-MICROSOFT-CDO-BUSYSTATUS'] === 'TENTATIVE' || String(e.description).includes('Tentative');
        if (isTentative) title = `⏳ [Tentative] ${title}`;

        return {
          id: e.uid,
          title: title,
          start: new Date(e.start).toISOString(),
          end: e.end ? new Date(e.end).toISOString() : null,
          description: e.description || '',
          color: '#818cf8',
          calendar: 'work',
          isExternal: true
        };
      });
    console.log(`Work Cache reloaded. Total: ${WORK_CACHE.length}`);
  } catch (err) {
    console.error("Work sync failed:", err.message);
  }
};

const runAllSyncs = async () => {
  await syncZoeFeed();
  await syncWorkFeed();
};
runAllSyncs();
setInterval(runAllSyncs, 5 * 60 * 1000);

// 3. HARD RE-MAPPING OF THE ROUTING DISPATCHER
app.get('/api/events', async (req, res) => {
  const targetView = req.query.calendar || 'combined';
  try {
    // Look up local database configurations
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

    // TARGET ROUTING VERIFICATION LOGIC:
    if (targetView === 'combined') {
      return res.json([...localEvents, ...ZOE_CACHE, ...WORK_CACHE]);
    }

    if (targetView === 'zoe') {
      // ONLY Zoe database items + ONLY Zoe automated stream entries
      return res.json([...localEvents, ...ZOE_CACHE]);
    }

    if (targetView === 'work') {
      // ONLY Work database items + ONLY Work Outlook entries
      return res.json([...localEvents, ...WORK_CACHE]);
    }

    // Liam's Life & Kids Logs view branch: Absolutely 0% external items can bleed here.
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
    await runAllSyncs();
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
    await runAllSyncs();
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
app.listen(PORT, () => console.log(`Isolation engine active on port ${PORT}`));
