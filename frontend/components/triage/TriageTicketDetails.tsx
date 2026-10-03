"use client";

import { useFormatter, useTranslations } from "next-intl";
import { ImageIcon, PencilIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { isTicketStatus, isTriagePriority, type TriageTicketRow } from "@/copilot/triageState";

/** Read-only ticket details (side sheet) opened from a row of the triage list. */
export function TriageTicketDetails({
  ticket,
  onClose,
}: {
  ticket: TriageTicketRow | null;
  onClose: () => void;
}) {
  const t = useTranslations("triage");
  const format = useFormatter();
  return (
    <Sheet open={ticket !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent side="right">
        {ticket ? (
          <>
            <SheetHeader>
              <SheetTitle>{t("details.title", { unit: ticket.unit })}</SheetTitle>
              <SheetDescription>{ticket.reporter_name}</SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 text-sm">
              <dt className="text-muted-foreground">{t("details.unit")}</dt>
              <dd className="font-medium">{ticket.unit}</dd>
              <dt className="text-muted-foreground">{t("details.reporter")}</dt>
              <dd>{ticket.reporter_name}</dd>
              <dt className="text-muted-foreground">{t("details.description")}</dt>
              <dd className="whitespace-pre-wrap">{ticket.description}</dd>
              <dt className="text-muted-foreground">{t("details.category")}</dt>
              <dd>{ticket.category_name ?? t("noCategory")}</dd>
              <dt className="text-muted-foreground">{t("details.contractor")}</dt>
              <dd>{ticket.contractor_name ?? t("noContractor")}</dd>
              <dt className="text-muted-foreground">{t("details.priority")}</dt>
              <dd>
                {isTriagePriority(ticket.priority)
                  ? t(`priority.${ticket.priority}`)
                  : ticket.priority}
              </dd>
              <dt className="text-muted-foreground">{t("details.status")}</dt>
              <dd>
                {isTicketStatus(ticket.status) ? t(`status.${ticket.status}`) : ticket.status}
              </dd>
              <dt className="text-muted-foreground">{t("details.created")}</dt>
              <dd>
                {ticket.created_at
                  ? format.dateTime(new Date(ticket.created_at), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">{t("details.reference")}</dt>
              <dd className="font-mono text-xs break-all">{ticket.guid}</dd>
            </dl>
            <div className="flex flex-wrap gap-2 px-4">
              {ticket.was_corrected ? (
                <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  <PencilIcon className="h-3 w-3" />
                  {t("corrected")}
                </Badge>
              ) : null}
              {ticket.has_photo ? (
                <Badge variant="outline">
                  <ImageIcon className="h-3 w-3" />
                  {t("photo")}
                </Badge>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
