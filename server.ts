import express from 'express';
import nodemailer from 'nodemailer';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post('/api/send-email', upload.single('pdf'), async (req, res) => {
    try {
      const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom, to, subject, text, filename } = req.body;

      if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword || !smtpFrom || !to) {
        return res.status(400).json({ error: 'Missing required SMTP or email fields' });
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort),
        secure: parseInt(smtpPort) === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPassword,
        },
      });

      const mailOptions: any = {
        from: smtpFrom,
        to: to,
        subject: subject || 'SafeTrack Report',
        text: text || 'Please find the attached report from SafeTrack.',
      };

      if (req.file) {
        mailOptions.attachments = [
          {
            filename: filename || 'report.pdf',
            content: req.file.buffer,
          },
        ];
      }

      await transporter.sendMail(mailOptions);
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error sending email:', error);
      res.status(500).json({ error: error.message || 'Failed to send email' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
