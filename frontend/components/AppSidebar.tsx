"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { NavMain } from "@/components/NavMain";
import { NavUser } from "@/components/NavUser";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { CurrentUser } from "@/graphql/user/user.types";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { WrenchIcon } from "lucide-react";
import { getNavMain } from "@/components/navItems";

/** Static app header (name + icon); links to the triage home screen. */
function AppHeader() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild tooltip="Linden Coop · Triage">
          <a href="/triage">
            <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
              <WrenchIcon className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">Linden Coop</span>
              <span className="truncate text-xs">Triage</span>
            </div>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  ssrUser: CurrentUser | null;
};

export function AppSidebar({ ssrUser, ...props }: AppSidebarProps) {
  const t = useTranslations("nav");

  const navMain = getNavMain(t);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <AppHeader />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
      </SidebarContent>
      <SidebarFooter>
        <LanguageSwitcher />
        <ThemeToggle />
        <SidebarSeparator />
        <NavUser ssrUser={ssrUser} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
