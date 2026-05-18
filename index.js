import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import multer from 'multer';
import ical from 'node-ical';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cron from 'node-cron';

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 5001;

// Global Configurations
app.use(cors());
app.use(express.json());

// Initialize Persistent Neon PostgreSQL Database Instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Gemini Core AI Engine
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ==========================================================================
   1. DATABASE SCHEMA ACCELERATION & BOOTSTRAPPING
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
   2. INTELLIGENT SYNCHRONIZATION PIPELINE (BACKEND)
   ========================================================================== */
async function executeCalendarSync() {
  console.log("🔄 Initiating high-speed replication down external iCal assets...");
  const sources = [
    { url: process.env.ICAL_URL_WORK, domain: 'work' },
    { url: process.env.ICAL_URL_ZOE, domain: 'family' }
  ];

  for (const source of sources) {
    if (!source.url) continue;
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

        // Perform Deep AI Analysis on Family Streams to Detect Kids Logs
        if (source.domain === 'family' && process.env.GEMINI_API_KEY) {
          try {
            const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Analyze this entry: Title: "${title}". Desc: "${desc}". Is this linked to children's behavior, school logs, or sports tracking? Return strict JSON format with keys: "isKidLog" (boolean), "sentiment" ("positive", "negative", "neutral").`;
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
   3. API INFRASTRUCTURE CONTROL PATHS
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

/* ==========================================================================
   4. MONOLITHIC VISUAL LAYER INTERFACE (DYNAMIC FRONT END SERVING)
   ========================================================================== */
app.get('*', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Intelligent Master Hub Workspace</title>
      <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
      <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
      <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/@fullcalendar/index@6.1.11/index.global.min.js"></script>
      
      <style>
        :root {
          --bg-main: #090d16; --bg-card: #131c2e; --accent: #38bdf8;
          --border: #22314d; --text: #f8fafc; --text-muted: #94a3b8;
        }
        body, html { margin:0; padding:0; background: var(--bg-main); color: var(--text); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; overflow-x:hidden; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--bg-main); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        
        /* High-End Animations */
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes slideIn { from { transform: translateY(20px); opacity:0; } to { transform: translateY(0); opacity:1; } }
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        
        .anim-spin { animation: spin 1s linear infinite; }
        .anim-fade { animation: fadeIn 0.25s ease-out forwards; }
        .anim-slide { animation: slideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        
        /* Modern UI Components */
        .glass-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5); }
        .input-control { width:100%; padding:12px; background:#0b111e; border:1px solid var(--border); border-radius:10px; color:#fff; font-size:14px; box-sizing:border-box; transition:0.2s; }
        .input-control:focus { border-color: var(--accent); outline:none; box-shadow: 0 0 0 3px rgba(56,189,248,0.15); }
        .btn { padding: 12px 20px; border:none; border-radius:10px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:8px; justify-content:center; transition: 0.2s; font-size:14px; }
        .btn-primary { background: var(--accent); color: #090d16; }
        .btn-primary:hover { opacity:0.9; transform: translateY(-1px); }
        .btn-secondary { background: #22314d; color: #fff; }
        .btn-secondary:hover { background: #2d3f63; }
        .btn-danger { background: #ef4444; color: #fff; }
        .btn-danger:hover { background: #dc2626; }
        
        /* Calendar Styling Customizations Overrides */
        .fc { --fc-border-color: #22314d; --fc-page-bg-color: transparent; }
        .fc .fc-toolbar-title { font-size: 1.25rem; font-weight: 700; color: #fff; }
        .fc .fc-button-primary { background: #1b2842; border: 1px solid var(--border); color: #fff; font-weight: 600; text-transform: capitalize; border-radius: 8px; }
        .fc .fc-button-primary:hover { background: #243557; }
        .fc .fc-button-active { background: var(--accent) !important; color:#090d16 !important; }
        .fc-theme-standard td, .fc-theme-standard th { border: 1px solid #1f2c44 !important; }
        .fc-daygrid-day:hover { background: rgba(56,189,248,0.03); cursor: pointer; }
      </style>
    </head>
    <body>
      <div id="workspace-root"></div>

      <script type="text/babel">
        const { useState, useEffect, useRef } = React;

        function WorkspaceApp() {
          // States
          const [events, setEvents] = useState([]);
          const [currentCal, setCurrentCal] = useState('combined');
          const [notes, setNotes] = useState('');
          const [isSyncing, setIsSyncing] = useState(false);
          const [isLoading, setIsLoading] = useState(true);
          const [selectedEvent, setSelectedEvent] = useState(null);
          
          // Form States
          const [isModalOpen, setIsModalOpen] = useState(false);
          const [formTitle, setFormTitle] = useState('');
          const [formStart, setFormStart] = useState('');
          const [formEnd, setFormEnd] = useState('');
          const [formDesc, setFormDesc] = useState('');
          const [formDomain, setFormDomain] = useState('combined');
          const [formSentiment, setFormSentiment] = useState('neutral');
          
          const calendarRef = useRef(null);
          const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);

          useEffect(() => {
            const handleResize = () => setIsMobile(window.innerWidth < 1024);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
          }, []);

          const fetchAllData = async () => {
            try {
              const res = await fetch(\`/api/events?calendar=\${currentCal}\`);
              const data = await res.json();
              setEvents(data);
              
              const notesRes = await fetch('/api/general-notes');
              const notesData = await notesRes.json();
              setNotes(notesData.content || '');
            } catch (err) {
              console.error(err);
            } finally {
              setIsLoading(false);
            }
          };

          useEffect(() => {
            fetchAllData();
          }, [currentCal]);

          const handleTriggerSync = async () => {
            setIsSyncing(true);
            try {
              await fetch('/api/sync-external', { method: 'POST' });
              await fetchAllData();
            } catch (err) {
              alert('Sync Engine failed to complete processing loop.');
            } finally {
              setIsSyncing(false);
            }
          };

          const handleCreateEvent = async (e) => {
            e.preventDefault();
            try {
              const res = await fetch('/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: formTitle, start: formStart, end: formEnd, description: formDesc, calendar: formDomain, sentiment: formSentiment })
              });
              if (res.ok) {
                setIsModalOpen(false);
                setFormTitle(''); setFormStart(''); setFormEnd(''); setFormDesc('');
                fetchAllData();
              }
            } catch (err) {}
          };

          const handleDeleteEvent = async (id) => {
            if (!confirm("Are you sure you want to permanently purge this record?")) return;
            try {
              await fetch(\`/api/events/\${id}\`, { method: 'DELETE' });
              setSelectedEvent(null);
              fetchAllData();
            } catch (err) {}
          };

          const handleVerifyKid = async (id, action) => {
            try {
              await fetch('/api/events/learn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventId: id, status: action })
              });
              fetchAllData();
            } catch (err) {}
          };

          const handleSaveNotes = async () => {
            try {
              await fetch('/api/general-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: notes })
              });
              alert('Scratchpad committed successfully.');
            } catch (err) {}
          };

          // FullCalendar Initialization
          useEffect(() => {
            if (isLoading) return;
            const calendarEl = document.getElementById('calendar-anchor');
            if (!calendarEl) return;

            const calendar = new FullCalendar.Calendar(calendarEl, {
              plugins: [window.FullCalendar.globalPlugins.dayGrid, window.FullCalendar.globalPlugins.timeGrid, window.FullCalendar.globalPlugins.interaction],
              initialView: isMobile ? 'timeGridDay' : 'dayGridMonth',
              headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: isMobile ? 'timeGridDay' : 'dayGridMonth,timeGridWeek,timeGridDay'
              },
              events: events,
              height: '100%',
              selectable: true,
              select: (info) => {
                const pad = (n) => String(n).padStart(2,'0');
                const d = info.start;
                setFormStart(\`\${d.getFullYear()}-\${pad(d.getMonth()+1)}-\\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}\`);
                setIsModalOpen(true);
              },
              eventClick: (info) => {
                const props = info.event.extendedProps;
                setSelectedEvent({
                  id: info.event.id,
                  title: info.event.title,
                  start: info.event.startStr,
                  end: info.event.endStr,
                  description: props.description,
                  calendar: props.calendar,
                  sentiment: props.sentiment
                });
              },
              eventContent: (info) => {
                const ext = info.event.extendedProps;
                let dot = '#64748b';
                if (ext.calendar === 'work') dot = '#0284c7';
                if (ext.calendar === 'family') dot = '#10b981';
                if (ext.calendar === 'kids-logs') {
                  dot = ext.sentiment === 'positive' ? '#10b981' : ext.sentiment === 'negative' ? '#ef4444' : '#f59e0b';
                }
                return {
                  html: \`<div style="display:flex;align-items:center;gap:6px;padding:3px;font-size:12px;color:#fff;overflow:hidden;text-overflow:ellipsis;">
                           <span style="width:8px;height:8px;border-radius:50%;background:\${dot};flex-shrink:0;"></span>
                           <b style="opacity:0.8;white-space:nowrap;">\${info.timeText}</b>
                           <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${info.event.title}</span>
                         </div>\`
                };
              }
            });

            calendar.render();
            calendarRef.current = calendar;

            return () => calendar.destroy();
          }, [events, isLoading, isMobile]);

          if (isLoading) {
            return (
              <div style={{ display:'flex', height:'100vh', width:'100vw', justifyContent:'center', alignItems:'center', background:'#090d16' }}>
                <div className="anim-spin" style={{ width:'50px', height:'50px', border:'4px solid #22314d', borderTopColor:'#38bdf8', borderRadius:'50%' }}></div>
              </div>
            );
          }

          return (
            <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', minHeight: '100vh', boxSizing: 'border-box' }}>
              
              {/* SIDEBAR NAVIGATION ENGINE */}
              <div style={{ width: isMobile ? '100%' : '360px', background: '#111827', borderRight: isMobile ? 'none' : '1px solid var(--border)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px', boxSizing: 'border-box' }}>
                <div>
                  <h1 style={{ fontSize:'22px', fontWeight:'800', margin:0, color:'var(--accent)', letterSpacing:'-0.5px' }}>Master Hub</h1>
                  <p style={{ color:'var(--text-muted)', fontSize:'13px', margin:'4px 0 0 0' }}>Enterprise Workspace Control</p>
                </div>

                <button onClick={handleTriggerSync} disabled={isSyncing} className="btn btn-primary" style={{ width:'100%', padding:'14px' }}>
                  {isSyncing ? (
                    <span style={{ display:'flex', alignItems:'center', gap: '8px' }}>
                      <div className="anim-spin" style={{ width:'16px', height:'16px', border:'2px solid #090d16', borderTopColor:'transparent', borderRadius:'50%' }}></div>
                      Replicating Feeds...
                    </span>
                  ) : "🔄 Force Refresh Feeds"}
                </button>

                <div>
                  <label style={{ display:'block', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', color:'var(--text-muted)', marginBottom:'8px' }}>Active View Metric</label>
                  <select value={currentCal} onChange={(e) => setCurrentCal(e.target.value)} className="input-control" style={{ fontSize:'15px' }}>
                    <option value="combined">Combined Systems Grid</option>
                    <option value="work">Work Operations</option>
                    <option value="family">Family Framework</option>
                    <option value="kids-logs">Kids Behavioral Stream</option>
                  </select>
                </div>

                <button onClick={() => setIsModalOpen(true)} className="btn btn-secondary" style={{ width:'100%' }}>+ Manual Log Entry</button>

                <hr style={{ borderColor: 'var(--border)', margin:0 }} />

                {/* AI UNVERIFIED QUEUE EXCLUSION INTERFACE */}
                <div>
                  <h3 style={{ fontSize:'12px', textTransform:'uppercase', color:'var(--text-muted)', margin:'0 0 12px 0' }}>Gemini Incoming Exception Queue</h3>
                  <div style={{ display:'flex', flexDirection:'column', gap:'10px', maxHeight:'200px', overflowY:'auto' }}>
                    {events.filter(e => e.isUnverified).length === 0 ? (
                      <p style={{ fontSize:'13px', color:'var(--text-muted)', margin:0, fontStyle:'italic' }}>No anomalies isolated for review.</p>
                    ) : (
                      events.filter(e => e.isUnverified).map(ev => (
                        <div key={ev.id} className="glass-panel anim-slide" style={{ padding:'12px', background:'#0b111e', borderRadius:'10px', borderLeft:'4px solid #ef4444' }}>
                          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'6px' }}>{ev.title}</div>
                          <div style={{ display:'flex', gap:'6px' }}>
                            <button onClick={() => handleVerifyKid(ev.id, 'verified_kid')} className="btn btn-primary" style={{ padding:'6px 12px', fontSize:'11px' }}>Verify</button>
                            <button onClick={() => handleVerifyKid(ev.id, 'blocked')} className="btn btn-danger" style={{ padding:'6px 12px', fontSize:'11px' }}>Purge</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* SCRATCHPAD ASSIGNMENT COMPONENT */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '180px' }}>
                  <h3 style={{ fontSize:'12px', textTransform:'uppercase', color:'var(--text-muted)', margin:0 }}>Persistent Processing Scratchpad</h3>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="input-control" style={{ flex:1, resize:'none', lineHeight:'1.5' }} placeholder="Type running telemetry data notes here..." />
                  <button onClick={handleSaveNotes} className="btn btn-secondary" style={{ width:'100%', fontSize:'13px' }}>Commit Scratchpad Data</button>
                </div>
              </div>

              {/* CALENDAR CANVAS GRID */}
              <div style={{ flex: 1, padding: isMobile ? '12px' : '32px', boxSizing: 'border-box', height: isMobile ? 'auto' : '100vh', display:'flex', flexDirection:'column' }}>
                <div className="glass-panel anim-fade" style={{ flex: 1, padding: '24px', background: 'var(--bg-card)', height:'100%', boxSizing:'border-box' }}>
                  <div id="calendar-anchor" style={{ height: '100%' }}></div>
                </div>
              </div>

              {/* EVENT MANAGER DRILLDOWN INSIGHT INSPECTOR */}
              {selectedEvent && (
                <div className="anim-fade" style={{ position:'fixed', top:0, left:0, width:'100vw', height:'100vh', background:'rgba(5,7,12,0.8)', display:'flex', justifyContent:'center', alignItems:'center', zIndex:9999 }}>
                  <div className="glass-panel anim-slide" style={{ width:'100%', maxWidth:'480px', padding:'28px', background:'var(--bg-card)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'start', marginBottom:'16px' }}>
                      <span style={{ fontSize:'11px', fontWeight:'700', textTransform:'uppercase', padding:'4px 8px', background:'#22314d', borderRadius:'6px', color:'var(--accent)' }}>{selectedEvent.calendar} Domain</span>
                      <button onClick={() => setSelectedEvent(null)} style={{ background:'none', border:'none', color:'#fff', cursor:'pointer', fontSize:'18px' }}>&times;</button>
                    </div>
                    <h2 style={{ margin:'0 0 12px 0', fontSize:'22px', fontWeight:'700' }}>{selectedEvent.title}</h2>
                    <p style={{ color:'var(--text-muted)', fontSize:'14px', margin:'0 0 20px 0', lineHeight:'1.6' }}>{selectedEvent.description || "No context provided for this entry block."}</p>
                    <div style={{ display:'flex', gap:'12px', justifyContent:'flex-end' }}>
                      <button onClick={() => setSelectedEvent(null)} className="btn btn-secondary">Close Insight</button>
                      <button onClick={() => handleDeleteEvent(selectedEvent.id)} className="btn btn-danger">Purge Record</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ACTION LOG INPUT MATRIX MODAL */}
              {isModalOpen && (
                <div className="anim-fade" style={{ position:'fixed', top:0, left:0, width:'100vw', height:'100vh', background:'rgba(5,7,12,0.8)', display:'flex', justifyContent:'center', alignItems:'center', zIndex:9998 }}>
                  <div className="glass-panel anim-slide" style={{ width:'100%', maxWidth:'500px', padding:'28px', background:'var(--bg-card)' }}>
                    <h3 style={{ margin:'0 0 20px 0', fontSize:'20px', fontWeight:'700', color:'var(--accent)' }}>Log Action Metric Entry</h3>
                    <form onSubmit={handleCreateEvent} style={{ display:'flex', flexDirection:'column', gap:'16px' }}>
                      <div>
                        <label style={{ display:'block', fontSize:'12px', color:'var(--text-muted)', marginBottom:6 }}>Identity Label</label>
                        <input type="text" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} className="input-control" required />
                      </div>
                      <div style={{ display:'flex', gap:'12px', flexDirection: isMobile ? 'column' : 'row' }}>
                        <div style={{ flex:1 }}>
                          <label style={{ display:'block', fontSize:'12px', color:'var(--text-muted)', marginBottom:6 }}>Start Marker</label>
                          <input type="datetime-local" value={formStart} onChange={(e) => setFormStart(e.target.value)} className="input-control" required />
                        </div>
                        <div style={{ flex:1 }}>
                          <label style={{ display:'block', fontSize:'12px', color(--text-muted)', marginBottom:6 }}>End Marker (Optional)</label>
                          <input type="datetime-local" value={formEnd} onChange={(e) => setFormEnd(e.target.value)} className="input-control" />
                        </div>
                      </div>
                      <div>
                        <label style={{ display:'block', fontSize:'12px', color:'var(--text-muted)', marginBottom:6 }}>Workspace Target Sector</label>
                        <select value={formDomain} onChange={(e) => setFormDomain(e.target.value)} className="input-control">
                          <option value="combined">Combined Hub</option>
                          <option value="work">Work Space</option>
                          <option value="family">Family Framework</option>
                          <option value="kids-logs">Kids Behavioral Streams</option>
                        </select>
                      </div>
                      {formDomain === 'kids-logs' && (
                        <div>
                          <label style={{ display:'block', fontSize:'12px', color:'var(--text-muted)', marginBottom:6 }}>Sentiment Evaluation Axis</label>
                          <select value={formSentiment} onChange={(e) => setFormSentiment(e.target.value)} className="input-control">
                            <option value="neutral">Neutral Balance</option>
                            <option value="positive">Positive Vector</option>
                            <option value="negative">Negative Flag Event</option>
                          </select>
                        </div>
                      )}
                      <div>
                        <label style={{ display:'block', fontSize:'12px', color:'var(--text-muted)', marginBottom:6 }}>Context Note Summary</label>
                        <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} rows={3} className="input-control" style={{ resize:'none' }} />
                      </div>
                      <div style={{ display:'flex', justifyContent:'flex-end', gap:'12px', marginTop:'8px' }}>
                        <button type="button" onClick={() => setIsModalOpen(false)} className="btn btn-secondary">Cancel</button>
                        <button type="submit" className="btn btn-primary">Inject Record</button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

            </div>
          );
        }

        const root = ReactDOM.createRoot(document.getElementById('workspace-root'));
        root.render(<WorkspaceApp />);
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`⚡ Production Monolith Core Active and Serving Framework on port: ${PORT}`);
});
