"use client";

import {
  CopilotChatConfigurationProvider,
  CopilotKit,
  CopilotSidebar,
  CopilotThreadsDrawer,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import "./copilot.css";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  COPILOT_AGENT_NAME,
  COPILOT_EMBEDDED_CHAT_ROUTES,
  COPILOT_RUNTIME_URL,
  copilotPublicApiKey,
  isCopilotEnabled,
} from "./config";
import { CopilotToolRenders } from "./CopilotToolRenders";
import { copilotAttachments } from "./attachments";

/**
 * Wraps the authenticated app in the CopilotKit provider + chat sidebar.
 *
 * - Gated by the `NEXT_PUBLIC_COPILOT_ENABLED` flag; when off, renders children
 *   untouched (no provider, no bundle-visible widget).
 * - Transport is pinned to multi-route (`useSingleEndpoint={false}`), matching
 *   the catch-all handler in `app/api/copilotkit/[[...slug]]/route.ts`.
 * - Authenticated users get the Intelligence threads drawer (when Intelligence is
 *   configured on the server; docked right of the
 *   content, clear of the fixed app nav) and
 *   the v2 chat sidebar; both share one `CopilotChatConfigurationProvider`, so
 *   picking a thread in the drawer switches the sidebar's conversation.
 * - Routes with an embedded `<CopilotChat>` (`/triage`) skip the sidebar: both would bind to the same
 *   agent + thread and show the same conversation twice. The drawer stays and drives the embedded chat.
 * - The chat surface only mounts for authenticated users. `authenticated` is
 *   resolved on the server from the same `GET_ME` fetch the app layout already
 *   uses. When enabled the provider context is still mounted for unauthenticated
 *   renders so page-level `useCopilotReadable` hooks never orphan.
 */
export function CopilotProvider({
  authenticated,
  threadsEnabled,
  children,
}: {
  authenticated: boolean;
  /** Intelligence is configured on the server; without it there are no threads to list. */
  threadsEnabled: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("copilot");
  const pathname = usePathname();
  const embeddedChat = COPILOT_EMBEDDED_CHAT_ROUTES.some(
    (route) => pathname === route || pathname?.startsWith(`${route}/`)
  );

  if (!isCopilotEnabled()) return <>{children}</>;

  return (
    <CopilotKit
      runtimeUrl={COPILOT_RUNTIME_URL}
      agent={COPILOT_AGENT_NAME}
      publicApiKey={copilotPublicApiKey()}
      useSingleEndpoint={false}
    >
      {authenticated ? (
        <CopilotChatConfigurationProvider agentId={COPILOT_AGENT_NAME}>
          <CopilotToolRenders />
          {/* The app nav is a fixed left column, so the threads drawer docks on
              the right of the content (styled in copilot.css). */}
          <div className="flex min-h-svh w-full">
            <div className="flex min-w-0 flex-1">{children}</div>
            {threadsEnabled ? <CopilotThreadsDrawer /> : null}
          </div>
          {/* Image attachments: residents add a photo of the defect (multimodal input). */}
          {embeddedChat ? null : (
            <CopilotSidebar
              defaultOpen={false}
              attachments={copilotAttachments}
              labels={{
                modalHeaderTitle: t("title"),
                welcomeMessageText: t("initial"),
                chatInputPlaceholder: t("placeholder"),
              }}
            />
          )}
        </CopilotChatConfigurationProvider>
      ) : (
        children
      )}
    </CopilotKit>
  );
}
