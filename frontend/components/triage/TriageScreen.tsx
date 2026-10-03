"use client";

import { CopilotChat } from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { COPILOT_AGENT_NAME, isCopilotEnabled } from "@/copilot/config";
import { copilotAttachments } from "@/copilot/attachments";
import { LiveTriageTicketList, StaticTriageTicketList } from "./LiveTriageTicketList";

/**
 * The triage demo screen: the embedded v2 `<CopilotChat>` on the left (same agent and thread as
 * the threads drawer, photo attachments enabled) and the live "Tickets" list on the right,
 * driven by AG-UI shared state. The global CopilotSidebar is not mounted on this route
 * (see `COPILOT_EMBEDDED_CHAT_ROUTES`), so the conversation is shown once.
 */
export function TriageScreen() {
  const t = useTranslations("triage");
  const tc = useTranslations("copilot");
  const enabled = isCopilotEnabled();

  return (
    <div className="grid h-[calc(100svh-4rem)] min-h-[520px] grid-cols-1 gap-4 p-4 pt-0 lg:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
      <div
        data-testid="triage-chat"
        className="bg-card flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-sm"
      >
        {enabled ? (
          <CopilotChat
            agentId={COPILOT_AGENT_NAME}
            attachments={copilotAttachments}
            className="h-full min-h-0"
            labels={{
              welcomeMessageText: t("chatWelcome"),
              chatInputPlaceholder: tc("placeholder"),
            }}
          />
        ) : (
          <p className="text-muted-foreground m-auto p-6 text-sm">{t("chatDisabled")}</p>
        )}
      </div>
      <div className="min-h-0">
        {enabled ? <LiveTriageTicketList /> : <StaticTriageTicketList />}
      </div>
    </div>
  );
}
