/**
 * /unsubscribed — CAN-SPAM unsubscribe confirmation page.
 *
 * Rendered after a recipient clicks their unsubscribe link and the
 * /api/unsubscribe/sdr endpoint processes the opt-out.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Unsubscribed",
  description: "You have been removed from our outreach list.",
};

interface PageProps {
  searchParams: { status?: string };
}

export default function UnsubscribedPage({ searchParams }: PageProps) {
  const status = searchParams?.status ?? "success";

  return (
    <main>
      {status === "success" && (
        <>
          <h1>You&apos;ve been unsubscribed</h1>
          <p>
            Your email address has been removed from our outreach list. You will
            not receive any further emails from our SDR sequences.
          </p>
          <p className="muted">
            If you believe this was a mistake or would like to re-engage, feel
            free to reach out to us directly.
          </p>
        </>
      )}

      {status === "invalid" && (
        <>
          <h1>Invalid unsubscribe link</h1>
          <p>
            This unsubscribe link is invalid or has already been used. If you
            continue to receive emails and wish to opt out, please reply to any
            of our emails with &ldquo;unsubscribe&rdquo; in the subject line.
          </p>
        </>
      )}

      {status === "error" && (
        <>
          <h1>Something went wrong</h1>
          <p>
            We were unable to process your unsubscribe request. Please try
            again in a few moments, or reply directly to our email with
            &ldquo;unsubscribe&rdquo; in the subject line.
          </p>
        </>
      )}

      {status !== "success" && status !== "invalid" && status !== "error" && (
        <>
          <h1>Unsubscribed</h1>
          <p>Your unsubscribe request has been received.</p>
        </>
      )}
    </main>
  );
}
