import crypto from "crypto";

export interface CanSpamParams {
  companyName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  unsubscribeUrl: string;
}

/**
 * Generates CAN-SPAM Act §7704 compliant email footer with physical mailing
 * address and a one-click unsubscribe link.
 */
export function generateCanSpamFooter(params: CanSpamParams): {
  html: string;
  text: string;
} {
  const {
    companyName,
    street,
    city,
    state,
    zip,
    country = "USA",
    unsubscribeUrl,
  } = params;

  const addressLine = `${street}, ${city}, ${state} ${zip}, ${country}`;

  const html = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;font-family:Arial,sans-serif;line-height:1.6;">
  <p style="margin:0 0 6px;">You are receiving this email because you or your organization expressed interest in ${escapeHtml(companyName)}'s services.</p>
  <p style="margin:0 0 6px;">${escapeHtml(companyName)} &middot; ${escapeHtml(addressLine)}</p>
  <p style="margin:0;"><a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a> from future emails.</p>
</div>`;

  const text = [
    "",
    "---",
    `You are receiving this email because you or your organization expressed interest in ${companyName}'s services.`,
    `${companyName} · ${addressLine}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { html, text };
}

/**
 * Generates a 1×1 transparent tracking pixel whose URL is HMAC-SHA256 signed
 * to prevent spoofed open events. The open-tracking endpoint at
 * /api/sdr/track/open validates the token before recording the event.
 */
export function generateTrackingPixel(
  touchSendId: string,
  appUrl: string
): string {
  const secret = process.env.TRACKING_SECRET ?? "dev-tracking-secret";
  const token = crypto
    .createHmac("sha256", secret)
    .update(touchSendId)
    .digest("hex")
    .slice(0, 16);
  const src = `${appUrl}/api/sdr/track/open?id=${encodeURIComponent(touchSendId)}&t=${token}`;
  return `<img src="${src}" width="1" height="1" alt="" style="display:none;border:0;" />`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
