/**
 * SafeTrack server: serves the app and does the few things a browser must
 * never do itself. Every /api route requires a valid Supabase session and
 * checks the caller's church membership with the service role.
 *
 *   POST /api/send-email   email a report PDF (SMTP + recipients looked up here)
 *
 * Member management and the AI insight run as Supabase Edge Functions
 * (supabase/functions). Email can't: Edge Functions block outbound ports 25
 * and 587, which most church mail providers require.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import nodemailer from 'nodemailer';
import multer from 'multer';
import path from 'path';
import { createClient, type User } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET_KEY) {
  console.warn('SUPABASE_SECRET_KEY not set: the app will run, but emailing reports is disabled. See .env.example.');
}

// Service-role client: bypasses RLS. Only ever used after the checks below.
const admin = SUPABASE_URL && SECRET_KEY
  ? createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as ReturnType<typeof createClient>);
const emailEnabled = !!(SUPABASE_URL && SECRET_KEY);

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1 } });

type Membership = { church_id: string; role: string; display_name: string };
type AuthedRequest = Request & { user?: User; membership?: Membership };

// --- auth helpers ----------------------------------------------------------
async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!emailEnabled) return res.status(503).json({ error: 'Email is not configured on this server (SUPABASE_SECRET_KEY missing).' });
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
