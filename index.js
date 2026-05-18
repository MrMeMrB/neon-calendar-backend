import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import axios from 'axios';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001; 
const JWT_SECRET = "matrix_override_secure_token_99812";

// --- DATABASE SIMULATION LAYER (PRE-LOADED WITH YOUR DATA) ---
let usersDb = [];
let cachedExternalEvents = []; 

// Full restoration of your active work projects, family logs, and Zoe sync records
let eventsDb = [
  // --- CORPORATE OPERATIONS (WORK) ---
  { 
    id: "w1", 
    title: "Ford Dunton: DLX2 Benchmarking Execution", 
    start: "2026-05-12T09:00:00Z", 
    end: "2026-05-12T17:00:00Z", 
    description: "On-site review of Current Clamps and hardware diagnostic benchmarking run.", 
    calendar: "work", 
    domain: "work", 
    color: "#10b981" 
  },
  { 
    id: "w2", 
    title: "JCB Wardlow Support Session", 
    start: "2026-04-07T10:00:00Z", 
    end: "2026-04-07T15:00:00Z", 
    description: "EMX Daisy-Chaining diagnostic interface configuration patch.", 
    calendar: "work", 
    domain: "work", 
    color: "#10b981" 
  },
  
  // --- LIAM'S CORE LIFE & LEAVE MANAGEMENT ---
  { 
    id: "w3", 
    title: "Potters Resort Five Lakes Holiday", 
    start: "2026-07-10T09:00:00Z", 
    end: "2026-07-13T17:00:00Z", 
    description: "Full weekend family leave booked off (Friday and Monday fully confirmed).", 
    calendar: "liam-life", 
    domain: "internal", 
    color: "#6366f1" 
  },
  { 
    id: "w4", 
    title: "September Holiday Block", 
    start: "2026-09-18T09:00:00Z", 
    end: "2026-09-25T12:00:00Z", 
    description: "Autumn leave rotation block. Out of office.", 
    calendar: "liam-life", 
    domain: "internal", 
    color: "#6366f1" 
  },
  
  // --- ZOE SHARED MATRIX TIMELINE ---
  { 
    id: "z1", 
    title: "Zoe Coordination Sync", 
    start: "2026-05-20T18:30:00Z", 
    end: "2026-05-20T21:00:00Z", 
    description: "Household tracking and upcoming calendar sequence alignment.", 
    calendar: "zoe", 
    domain: "zoe", 
    color: "#f43f5e" 
  },
  { 
    id: "z2", 
    title: "Family Shared Dinner Rotation", 
    start: "2026-05-24T17:00:00Z", 
    end: "2026-05-24T20:00:00Z", 
    description: "Weekend dinner block with Zoe and the kids.", 
    calendar: "zoe", 
    domain: "zoe", 
    color: "#f43f5e" 
  },

  // --- CHILD TRACKING & MANAGEMENT LOGS ---
  { 
    id: "k1", 
    title: "Indie & Jasper Activity Log", 
    start: "2026-05-19T08:30:00Z", 
    end: "2026-05-19T15:30:00Z", 
    description: "School attendance confirmation frame.", 
    calendar: "kids-logs", 
    domain: "kids-logs", 
    color: "#f97316" 
  },
  { 
    id: "k2", 
    title: "Jack & George Co-Parenting Handover", 
    start: "2026-05-22T16:00:00Z", 
    end: "2026-05-22T17:00:00Z", 
    description: "Standard custody schedule rotation tracking point.", 
    calendar: "kids-logs", 
    domain: "kids-logs", 
    color: "#f97316" 
  }
];

// Fallback school URL (Replace with your direct active public iCal link when ready)
const PUBLIC_SCHOOL_CALENDAR_URL = "https://calendar.google.com/calendar/ical/example/public/basic.ics";

if (usersDb.length === 0) {
  const salt = bcrypt.genSaltSync(10);
  usersDb.push({
    id: "u1",
    username: "LiamBaker",
    password: bcrypt.hashSync("password123", salt)
  });
}

/**
 * Normalization Protocol: Intercepts raw inputs and guarantees uniform data shapes
 */
function normalizeEvent(raw, sourceCategory) {
  const cleanCategory = String(sourceCategory || 'liam-life').toLowerCase().trim();
  let domain = 'internal';
  let color = '#6366f1'; 

  if (cleanCategory.includes('school') || cleanCategory.includes('abington')) {
    domain = 'school';
    color = '#38bdf8'; 
  } else if (cleanCategory === 'work') {
    domain = 'work';
    color = '#10b981'; 
  } else if (cleanCategory === 'zoe') {
    domain = 'zoe';
    color = '#f43f5e'; 
  } else if (cleanCategory === 'kids-logs') {
    domain = 'kids-logs';
    color = '#f97316'; 
  }

  return {
    id: raw.id || raw.uid || Math.random().toString(36).substring(2, 9),
    title: raw.title || raw.summary || 'Untitled Core Event',
    start: raw.start || raw.dtstart || new Date().toISOString(),
    end: raw.end || raw.dtend || new Date().toISOString(),
    description: raw.description || '',
    calendar: cleanCategory,
    domain: domain,
    color: color
  };
}

// --- AUTOMATED ICAL FEED SYNC BACKGROUND ENGINE ---
async function syncExternalFeeds() {
  console.log("🔄 Background Sync Init: Scraping external iCal matrix arrays...");
  try {
    const response = await axios.get(PUBLIC_SCHOOL_CALENDAR_URL, { timeout: 6000 });
    const rawFeedItems = Array.isArray(response.data) ? response.data : [];
    cachedExternalEvents = rawFeedItems.map(item => normalizeEvent(item, 'abington-school'));
    console.log(`✅ Cached ${cachedExternalEvents.length} distinct events from Abington School.`);
  } catch (err) {
    console.error("⚠️ External iCal feed sync dropped. Using existing memory architecture.", err.message);
  }
}
cron.schedule('*/30 * * * *', syncExternalFeeds);
syncExternalFeeds();

// --- SECURE ROUTING AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access token missing." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token signature invalid or expired." });
    req.user = user;
    next();
  });
}

// --- LIVE API ENDPOINTS ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = usersDb.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: "Invalid operational access credentials." });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { name: user.username } });
});

app.get('/api/events', authenticateToken, (req, res) => {
  const combined = [...eventsDb, ...cachedExternalEvents];
  combined.sort((a, b) => new Date(a.start) - new Date(b.start));
  res.json(combined);
});

app.post('/api/events', authenticateToken, (req, res) => {
  const { title, start, description, calendar } = req.body;
  if (!title || !start) return res.status(400).json({ error: "Title and Start dates are required." });
  
  const newEvent = normalizeEvent({ title, start, description }, calendar);
  eventsDb.push(newEvent);
  res.status(201).json(newEvent);
});

app.delete('/api/events/:id', authenticateToken, (req, res) => {
  eventsDb = eventsDb.filter(e => e.id !== req.params.id);
  res.json({ success: true, message: "Entry expunged from system local storage." });
});

// --- SAFE RUNTIME PDF LOG REPORT GENERATOR ---
app.get('/api/reports/pdf', authenticateToken, async (req, res) => {
  try {
    const { PDFDocument, rgb } = require('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    
    page.drawText('GRIDNODE SYSTEM PERFORMANCE LOGS & INCIDENTS REPORT', { x: 50, y: 750, size: 16, color: rgb(0.1, 0.1, 0.2) });
    page.drawText(`Generated on: ${new Date().toLocaleString()}`, { x: 50, y: 725, size: 10, color: rgb(0.4, 0.4, 0.4) });

    let yOffset = 680;
    const criticalLogs = eventsDb.filter(e => e.calendar === 'kids-logs');
    
    if (criticalLogs.length === 0) {
      page.drawText('No active tracking incident anomalies reported inside this sector timeframe.', { x: 50, y: yOffset, size: 11 });
    } else {
      criticalLogs.forEach((log) => {
        if (yOffset > 100) {
          page.drawText(`• [${new Date(log.start).toLocaleDateString()}] ${log.title}`, { x: 50, y: yOffset, size: 11 });
          yOffset -= 20;
          if (log.description) {
            page.drawText(`  Notes: ${log.description.substring(0, 75)}`, { x: 60, y: yOffset, size: 9, color: rgb(0.3, 0.3, 0.3) });
            yOffset -= 20;
          }
        }
      });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=system-incident-report.pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: "Failed to generate system printable file asset." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Core Secure Matrix Stack listening safely on port ${PORT}`);
});
