import { Resend } from 'resend';
import { env } from '../env';

export const resend = new Resend(env.RESEND_API_KEY);

export async function sendLoginCode(to: string, code: string) {
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: [to],
    subject: `${code} is your Naqiwha code`,
    text: `Your Naqiwha code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: loginCodeHtml(code),
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

// Email clients strip <style> and block images: tables + inline styles only.
function loginCodeHtml(code: string) {
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Naqiwha code</title></head>
<body style="margin:0;padding:0;background-color:#F2F5F3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F5F3;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;background-color:#FFFFFF;border-radius:16px;border-top:6px solid #006233;">
      <tr><td style="padding:28px 32px 8px 32px;${font}font-size:24px;font-weight:800;color:#0B3D2E;">Naqiwha</td></tr>
      <tr><td style="padding:8px 32px 0 32px;${font}font-size:16px;color:#3A4A42;">Your login code</td></tr>
      <tr><td style="padding:16px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EAF4EE;border-radius:12px;">
          <tr><td align="center" style="padding:20px 12px;${font}font-size:32px;font-weight:700;letter-spacing:8px;color:#006233;">${code}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 32px 8px 32px;${font}font-size:14px;color:#3A4A42;">Expires in 10 minutes.</td></tr>
      <tr><td style="padding:0 32px 28px 32px;${font}font-size:13px;color:#7A8A82;">If you didn't ask for this code, you can ignore this email.</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;">
      <tr><td align="center" style="padding:16px;${font}font-size:12px;color:#7A8A82;">Naqiwha · Clean spots together</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
