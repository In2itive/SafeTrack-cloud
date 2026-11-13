import { supabase } from './supabase';

/**
 * Email a report PDF. The server looks up this church's SMTP settings and the
 * recipient list itself; neither the SMTP password nor the recipients are
 * chosen by the browser, so the endpoint can't be used as an open relay.
 */
export async function sendEmailWithPDF(
  pdfBlob: Blob,
  filename: string,
  reportType: 'accounting' | 'envelope' | 'deposit'
) {
  const { data } = await supabase.auth.getSession();
  const formData = new FormData();
  formData.append('reportType', reportType);
  formData.append('filename', filename);
  formData.append('pdf', pdfBlob, filename);

  const response = await fetch('/api/send-email', {
    method: 'POST',
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: formData,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Failed to send email');
  }
  return body;
}
