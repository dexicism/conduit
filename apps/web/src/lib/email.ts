import "server-only";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env, emailMode } from "./env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface OutboxEntry extends EmailMessage {
  sentAt: string;
}

export function outboxFile(): string {
  // Dev-only file; tell the bundler not to trace the working directory into the server output.
  return resolve(/*turbopackIgnore: true*/ process.cwd(), env.OUTBOX_PATH);
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (emailMode === "resend") {
    const { Resend } = await import("resend");
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, ...msg });
    if (error) throw new Error(`Email delivery failed: ${error.message}`);
    return;
  }
  if (emailMode === "smtp") {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(env.SMTP_URL);
    await transport.sendMail({ from: env.EMAIL_FROM, ...msg });
    return;
  }
  // Development: no provider configured. Write to a local outbox that the
  // /dev/outbox page and the E2E tests read.
  const file = outboxFile();
  await mkdir(dirname(file), { recursive: true });
  const entry: OutboxEntry = { ...msg, sentAt: new Date().toISOString() };
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  console.info(`[dev-outbox] ${msg.subject} -> ${msg.to}`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function signInCodeEmail(to: string, code: string): EmailMessage {
  const subject = `${code} is your Conduit sign-in code`;
  const text = `Your Conduit sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0b0b10;color:#e8e8f0;padding:32px">
  <div style="max-width:440px;margin:0 auto;background:#14141c;border:1px solid #2a2a38;border-radius:14px;padding:28px">
    <p style="margin:0 0 8px;font-size:14px;color:#9a9ab0">Conduit</p>
    <h1 style="margin:0 0 16px;font-size:20px">Your sign-in code</h1>
    <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:0 0 16px">${escapeHtml(code)}</p>
    <p style="font-size:14px;color:#9a9ab0;margin:0">It expires in 10 minutes. If you didn't try to sign in, ignore this email.</p>
  </div></body></html>`;
  return { to, subject, text, html };
}
