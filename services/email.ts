import { db } from './db';

export async function sendEmailWithPDF(
  pdfBlob: Blob,
  filename: string,
  reportType: 'accounting' | 'envelope' | 'deposit'
) {
  const settings = await db.settings.orderBy('id').first();

  if (!settings || !settings.smtpHost || !settings.smtpPort || !settings.smtpUser || !settings.smtpPassword || !settings.smtpFrom) {
    throw new Error('SMTP settings are not configured. Please configure them in the Admin Settings.');
  }

  let to = '';
  if (reportType === 'accounting') to = settings.accountingRecipients || '';
  if (reportType === 'envelope') to = settings.envelopeRecipients || '';
  if (reportType === 'deposit') to = settings.depositRecipients || '';

  if (!to) {
    throw new Error(`No recipients configured for ${reportType} report. Please configure them in the Admin Settings.`);
  }

  const formData = new FormData();
  formData.append('smtpHost', settings.smtpHost);
  formData.append('smtpPort', settings.smtpPort.toString());
  formData.append('smtpUser', settings.smtpUser);
  formData.append('smtpPassword', settings.smtpPassword);
  formData.append('smtpFrom', settings.smtpFrom);
  formData.append('to', to);
  formData.append('subject', `SafeTrack ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Report`);
  formData.append('text', `Please find the attached ${reportType} report from SafeTrack.`);
  formData.append('filename', filename);
  formData.append('pdf', pdfBlob, filename);

  const response = await fetch('/api/send-email', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Failed to send email');
  }

  return await response.json();
}
