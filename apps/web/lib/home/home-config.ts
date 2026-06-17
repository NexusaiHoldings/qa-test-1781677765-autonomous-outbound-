/**
 * home-config — the company's root surface (company-root-landing-001).
 * Written by provisioning (_step_substrate_install) from CTO home_mode
 * + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeConfig {
  mode: "landing" | "conversation";
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Your SDR just showed up. No hire required.",
  "subhead": "An autonomous AI SDR that handles the full outbound loop \u2014 prospect research, personalized email sequences, follow-up touches, and calendar booking \u2014 for $499/mo flat, purpose-built for founder-led professional services firms (legal, accoun"
};
