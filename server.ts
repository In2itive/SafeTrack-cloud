/**
 * SafeTrack server: serves the app and does the few things a browser must
 * never do itself. Every /api route requires a valid Supabase session and
 * checks the caller's church membership with the service role.
 *
 *   POST   /api/send-email                         email a report PDF (SMTP + recipients looked up here)
 *   GET    /api/churches/:id/members               list members with emails
 *   POST   /api/churches/:id/members               admin: create a login + membership
 *   PATCH  /api/churches/:id/members/:userId       admin: rename, change role, reset password
 *   DELETE /api/churches/:id/members/:userId       admin: remove from church
 *   POST   /api/insight                            one-line AI summary from aggregate numbers
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import nodemailer from 'nodemailer';
import multer from 'multer';
import path from 'path';
import { createClient, type User } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error('SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SECRET_KEY must be set. See .env.example.');
  process.exit(1);
}

// Service-role client: bypasses RLS. Only ever used after the checks below.
const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1 } });
const ROLES = new Set(['administrator', 'treasurer', 'envelope', 'teller']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Membership = { church_id: string; role: string; display_name: string };
type AuthedRequest = Request & { user?: User; membership?: Membership };

// --- auth helpers ----------------------------------------------------------
async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.user = data.user;
  next();
}

async function membershipOf(userId: string, churchId?: string): Promise<Membership | null> {
  let q = admin.from('church_members').select('church_id, role, display_name')
    .eq('user_id', userId).eq('is_active', true);
  if (churchId) q = q.eq('church_id', churchId);
  const { data } = await q.limit(1);
  return (data?.[0] as Membership) ?? null;
}

/** Caller must be an active member of :id (and optionally hold one of `roles`). */
const requireMember = (roles?: string[]) => async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const churchId = req.params.id;
  if (!UUID.test(churchId)) return res.status(400).json({ error: 'Invalid church id' });
  const m = await membershipOf(req.user!.id, churchId);
  if (!m) return res.status(403).json({ error: 'Not a member of this church' });
  if (roles && !roles.includes(m.role)) return res.status(403).json({ error: 'Administrator access required' });
  req.membership = m;
  next();
};

const wrap = (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => fn(req as AuthedRequest, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Server error' });
  });

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // --- email ---------------------------------------------------------------
  app.post('/api/send-email', requireUser, upload.single('pdf'), wrap(async (req, res) => {
    const reportType = String(req.body.reportType || '');
    const column = ({ accounting: 'accounting_recipients', envelope: 'envelope_recipients', deposit: 'deposit_recipients' } as const)[reportType as 'accounting'];
    if (!column) return res.status(400).json({ error: 'Unknown report type' });
    if (!req.file) return res.status(400).json({ error: 'Missing PDF' });

    const m = await membershipOf(req.user!.id);
    if (!m) return res.status(403).json({ error: 'Not a member of a church' });

    const [{ data: settings }, { data: smtpRows }] = await Promise.all([
      admin.from('church_settings').select(column).eq('church_id', m.church_id).single(),
      admin.rpc('get_smtp_for_server', { p_church_id: m.church_id }),
    ]);
    const to: string[] = (settings as any)?.[column] ?? [];
    const smtp = (smtpRows as any[])?.[0];
    if (!smtp?.host || !smtp?.password) return res.status(400).json({ error: 'Email (SMTP) is not configured. An administrator can set it up in Admin / Backup.' });
    if (to.length === 0) return res.status(400).json({ error: `No recipients configured for the ${reportType} report.` });

    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.port === 465,
      auth: { user: smtp.username, pass: smtp.password },
    });
    const label = reportType.charAt(0).toUpperCase() + reportType.slice(1);
    const filename = String(req.body.filename || 'report.pdf').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    await transporter.sendMail({
      from: smtp.from_address,
      to: to.join(', '),
      subject: `SafeTrack ${label} Report`,
      text: `Please find the attached ${reportType} report from SafeTrack, sent by ${m.display_name}.`,
      attachments: [{ filename, content: req.file.buffer, contentType: 'application/pdf' }],
    });
    res.json({ success: true, recipients: to.length });
  }));

  // --- members ---------------------------------------------------------------
  app.get('/api/churches/:id/members', requireUser, requireMember(), wrap(async (req, res) => {
    const { data, error } = await admin.from('church_members')
      .select('user_id, role, display_name, is_active').eq('church_id', req.params.id).order('display_name');
    if (error) throw error;
    const members = await Promise.all((data ?? []).map(async m => {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id);
      return { ...m, email: u.user?.email ?? '' };
    }));
    res.json({ members });
  }));

  app.post('/api/churches/:id/members', requireUser, requireMember(['administrator']), wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const display_name = String(req.body.display_name || '').trim();
    const role = String(req.body.role || '');
    const password = String(req.body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!display_name) return res.status(400).json({ error: 'Name is required' });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });

    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { display_name },
    });
    if (error || !created.user) {
      const msg = /already/i.test(error?.message || '') ? 'That email already has a SafeTrack login.' : (error?.message || 'Could not create login');
      return res.status(409).json({ error: msg });
    }
    const { error: mErr } = await admin.from('church_members').insert({
      church_id: req.params.id, user_id: created.user.id, role, display_name,
    });
    if (mErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw mErr;
    }
    res.status(201).json({ user_id: created.user.id });
  }));

  app.patch('/api/churches/:id/members/:userId', requireUser, requireMember(['administrator']), wrap(async (req, res) => {
    const { userId } = req.params;
    if (!UUID.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
    const target = await membershipOf(userId, req.params.id);
    if (!target) return res.status(404).json({ error: 'Not a member of this church' });

    const patch: Record<string, string> = {};
    if (req.body.display_name) patch.display_name = String(req.body.display_name).trim();
    if (req.body.role) {
      if (!ROLES.has(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
      patch.role = req.body.role;
    }
    if (Object.keys(patch).length) {
      const { error } = await admin.from('church_members').update(patch).eq('church_id', req.params.id).eq('user_id', userId);
      if (error) return res.status(400).json({ error: /administrator/i.test(error.message) ? 'A church must keep at least one active administrator.' : error.message });
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const { error } = await admin.auth.admin.updateUserById(userId, { password: String(req.body.password) });
      if (error) throw error;
    }
    res.json({ success: true });
  }));

  app.delete('/api/churches/:id/members/:userId', requireUser, requireMember(['administrator']), wrap(async (req, res) => {
    const { userId } = req.params;
    if (userId === req.user!.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
    // Membership only: their past sign-offs stay on record under their name.
    const { error } = await admin.from('church_members').delete().eq('church_id', req.params.id).eq('user_id', userId);
    if (error) return res.status(400).json({ error: /administrator/i.test(error.message) ? 'A church must keep at least one active administrator.' : error.message });
    res.json({ success: true });
  }));

  // --- AI insight (key never leaves the server; only aggregates are sent) ----
  app.post('/api/insight', requireUser, wrap(async (req, res) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.json({ insight: 'AI Assistant offline. (No API key configured on the server.)' });
    if (!(await membershipOf(req.user!.id))) return res.status(403).json({ error: 'Not a member of a church' });
    const total = Number(req.body.totalValue) || 0;
    const batches = Number(req.body.totalBatches) || 0;
    const count = Number(req.body.donationCount) || 0;
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
        contents: `You are a helpful church treasurer assistant. Vault stats: total value $${total.toFixed(2)}, ` +
                  `${batches} batches processed, ${count} donations recorded. Give a one-sentence encouraging ` +
                  `summary or practical tip for the treasurer. Professional yet warm.`,
      });
      res.json({ insight: response.text || 'Keep up the good work managing the funds!' });
    } catch (e) {
      console.error('Gemini error:', e);
      res.json({ insight: 'Unable to generate insights at this moment.' });
    }
  }));

  // Uploads that are too big, etc.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'PDF is too large' });
    next(err);
  });

  // --- app -----------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
