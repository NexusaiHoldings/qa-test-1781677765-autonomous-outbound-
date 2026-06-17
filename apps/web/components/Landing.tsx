/**
 * Landing — themed hero for landing-mode companies (company-root-landing-001).
 *
 * Server component, rendered inside <main> so it inherits the substrate theme +
 * element styling. Resolves missing config from COMPANY_NAME/COMPANY_DESCRIPTION
 * and falls back the primary CTA to the first non-Home nav entry, then to the
 * conversation surface at /assistant.
 */
import Link from "next/link";
import type { JSX } from "react";
import { homeConfig } from "@/lib/home/home-config";
import { NAV_CONFIG } from "@/lib/nav-config";
import { getSiteMedia } from "@/lib/site-media";

export async function Landing(): Promise<JSX.Element> {
  const name = process.env.COMPANY_NAME || "Portfolio Company";
  const launchVideo = await getSiteMedia("launch_video");
  const headline = homeConfig.headline || name;
  const subhead =
    homeConfig.subhead ||
    process.env.COMPANY_DESCRIPTION ||
    `Welcome to ${name}.`;

  const firstNav = NAV_CONFIG.primary.find((l) => l.href !== "/");
  const primary =
    homeConfig.primaryCta ||
    (firstNav
      ? { label: firstNav.label, href: firstNav.href }
      : { label: "Get started", href: "/assistant" });
  const secondary = homeConfig.secondaryCta;

  return (
    <section style={{ maxWidth: 720, padding: "32px 0 24px" }}>
      <h1 style={{ fontSize: "2.4rem", lineHeight: 1.12, marginBottom: "0.75rem" }}>
        {headline}
      </h1>
      <p
        style={{
          fontSize: "1.15rem",
          color: "var(--substrate-muted)",
          marginBottom: "1.75rem",
        }}
      >
        {subhead}
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link href={primary.href} className="btn">
          {primary.label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className="btn secondary">
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {launchVideo ? (
        <video
          controls
          playsInline
          preload="metadata"
          style={{
            width: "100%",
            marginTop: "2rem",
            borderRadius: 12,
            border: "1px solid var(--substrate-border)",
            aspectRatio: "16 / 9",
            objectFit: "cover",
          }}
          src={launchVideo}
        >
          Your browser does not support the video element.
        </video>
      ) : null}
    </section>
  );
}
