/**
 * ICP (Ideal Customer Profile) validation for SDR campaign setup.
 * Validates user-supplied ICP configuration before persisting to sdr_campaigns.
 */

export interface IcpConfig {
  readonly industries: string[];
  readonly companySizeMin: number;
  readonly companySizeMax: number;
  readonly geographies: string[];
  readonly jobTitles: string[];
  readonly excludeKeywords: string[];
}

export interface CampaignInput {
  readonly name: string;
  readonly icp: IcpConfig;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: Record<string, string>;
}

export const SUPPORTED_INDUSTRIES = [
  "legal",
  "accounting",
  "it_consulting",
  "financial_services",
  "management_consulting",
  "hr_consulting",
  "marketing_agency",
  "real_estate",
] as const;

export const SUPPORTED_GEOGRAPHIES = ["US"] as const;

export const JOB_TITLE_SUGGESTIONS = [
  "Founder",
  "Co-Founder",
  "Managing Partner",
  "Owner",
  "Principal",
  "President",
  "CEO",
  "Partner",
] as const;

const MAX_CAMPAIGN_NAME_LENGTH = 120;
const MAX_ARRAY_ITEMS = 50;
const MAX_KEYWORD_LENGTH = 80;
const MIN_COMPANY_SIZE = 1;
const MAX_COMPANY_SIZE = 10_000;

export function validateIcpConfig(icp: unknown): ValidationResult {
  const errors: Record<string, string> = {};

  if (!icp || typeof icp !== "object") {
    return { valid: false, errors: { icp: "ICP configuration is required" } };
  }

  const cfg = icp as Record<string, unknown>;

  if (!Array.isArray(cfg.industries) || cfg.industries.length === 0) {
    errors["industries"] = "Select at least one target industry";
  } else if (cfg.industries.length > MAX_ARRAY_ITEMS) {
    errors["industries"] = `Too many industries (max ${MAX_ARRAY_ITEMS})`;
  } else {
    const invalid = (cfg.industries as unknown[]).filter(
      (ind) => !SUPPORTED_INDUSTRIES.includes(ind as (typeof SUPPORTED_INDUSTRIES)[number]),
    );
    if (invalid.length > 0) {
      errors["industries"] = `Unknown industries: ${invalid.join(", ")}`;
    }
  }

  const sizeMin = Number(cfg.companySizeMin);
  if (!Number.isInteger(sizeMin) || sizeMin < MIN_COMPANY_SIZE) {
    errors["companySizeMin"] = `Minimum company size must be at least ${MIN_COMPANY_SIZE}`;
  }

  const sizeMax = Number(cfg.companySizeMax);
  if (!Number.isInteger(sizeMax) || sizeMax > MAX_COMPANY_SIZE) {
    errors["companySizeMax"] = `Maximum company size must not exceed ${MAX_COMPANY_SIZE}`;
  }

  if (!errors["companySizeMin"] && !errors["companySizeMax"] && sizeMin > sizeMax) {
    errors["companySizeMin"] = "Minimum must be less than or equal to maximum";
  }

  if (!Array.isArray(cfg.geographies) || cfg.geographies.length === 0) {
    errors["geographies"] = "Select at least one geography";
  } else {
    const invalidGeo = (cfg.geographies as unknown[]).filter(
      (geo) => !SUPPORTED_GEOGRAPHIES.includes(geo as (typeof SUPPORTED_GEOGRAPHIES)[number]),
    );
    if (invalidGeo.length > 0) {
      errors["geographies"] = `Unsupported geographies: ${invalidGeo.join(", ")}`;
    }
  }

  if (!Array.isArray(cfg.jobTitles) || cfg.jobTitles.length === 0) {
    errors["jobTitles"] = "Add at least one target job title";
  } else if (cfg.jobTitles.length > MAX_ARRAY_ITEMS) {
    errors["jobTitles"] = `Too many job titles (max ${MAX_ARRAY_ITEMS})`;
  }

  if (Array.isArray(cfg.excludeKeywords)) {
    if (cfg.excludeKeywords.length > MAX_ARRAY_ITEMS) {
      errors["excludeKeywords"] = `Too many keywords (max ${MAX_ARRAY_ITEMS})`;
    } else {
      const tooLong = (cfg.excludeKeywords as unknown[]).filter(
        (kw) => typeof kw === "string" && kw.length > MAX_KEYWORD_LENGTH,
      );
      if (tooLong.length > 0) {
        errors["excludeKeywords"] = `Each keyword must be ${MAX_KEYWORD_LENGTH} characters or fewer`;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateCampaignInput(input: unknown): ValidationResult {
  const errors: Record<string, string> = {};

  if (!input || typeof input !== "object") {
    return { valid: false, errors: { form: "Invalid form data" } };
  }

  const data = input as Record<string, unknown>;

  const name = String(data.name ?? "").trim();
  if (!name) {
    errors["name"] = "Campaign name is required";
  } else if (name.length > MAX_CAMPAIGN_NAME_LENGTH) {
    errors["name"] = `Campaign name must be ${MAX_CAMPAIGN_NAME_LENGTH} characters or fewer`;
  }

  const icpResult = validateIcpConfig(data.icp);
  if (!icpResult.valid) {
    Object.assign(errors, icpResult.errors);
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
