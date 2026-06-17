export type NavLink = {
  label: string;
  href: string;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Campaign Manager", href: "/campaigns" },
    { label: "ICP Setup", href: "/campaigns/new" },
    { label: "Reply Inbox", href: "/replies" },
    { label: "Meeting Pipeline", href: "/meetings" },
  ],
  groups: [
    {
      label: "Settings",
      links: [{ label: "Mailbox Connection", href: "/settings/mailbox" }],
    },
  ],
};
