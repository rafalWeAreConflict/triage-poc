import type * as React from "react";
import { InboxIcon, Settings2Icon, ZapIcon } from "lucide-react";

export type NavMainItem = {
  title: string;
  url: string;
  icon?: React.ReactNode;
  items?: { title: string; url: string }[];
};

/** Main app navigation. `t` is the `nav` namespace translator. The triage screen is the home page. */
export function getNavMain(t: (key: string) => string): NavMainItem[] {
  return [
    {
      title: t("triage"),
      url: "/triage",
      icon: <InboxIcon />,
    },
    {
      title: "Workflows",
      url: "/workflows",
      icon: <ZapIcon />,
      items: [
        { title: "All Workflows", url: "/workflows" },
        { title: "New Workflow", url: "/workflows/new" },
      ],
    },
    {
      title: t("settings"),
      url: "/settings",
      icon: <Settings2Icon />,
    },
  ];
}
