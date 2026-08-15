import { useEffect, useState } from "react";
import {
  useGetEmailTemplates,
  useUpdateEmailTemplates,
  getGetEmailTemplatesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { PLACEHOLDER_HINT } from "./RuleFormDialog";

interface ManualEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SectionDef {
  subjectField: "issuedEmailSubject" | "reminderEmailSubject" | "printavoEmailSubject";
  bodyField: "issuedEmailBody" | "reminderEmailBody" | "printavoEmailBody";
  title: string;
  hint: string;
  subjectPlaceholder: string;
  bodyPlaceholder: string;
  testId: string;
}

const SECTIONS: SectionDef[] = [
  {
    subjectField: "issuedEmailSubject",
    bodyField: "issuedEmailBody",
    title: "Manual issue email",
    hint: "Sent when you issue Mint Bucks by hand from the Issue page.",
    subjectPlaceholder: "e.g. You've received {{amount}} in Mint Bucks!",
    bodyPlaceholder: "e.g. We've added {{amount}} in Mint Bucks to your account as a thank-you.",
    testId: "manual-issue",
  },
  {
    subjectField: "reminderEmailSubject",
    bodyField: "reminderEmailBody",
    title: "Manual reminder email",
    hint: "Sent when you click \"Send Reminder\" on a credit.",
    subjectPlaceholder: "e.g. Don't forget your {{amount}} in Mint Bucks",
    bodyPlaceholder: "e.g. Just a reminder — you still have {{amount}} in Mint Bucks to use on your next order.",
    testId: "manual-reminder",
  },
  {
    subjectField: "printavoEmailSubject",
    bodyField: "printavoEmailBody",
    title: "New-order notification email",
    hint: "Sent automatically when a customer with unspent Mint Bucks gets a new Printavo quote or invoice. Extra placeholder: {{orderNumber}}.",
    subjectPlaceholder: "e.g. Use your {{amount}} in Mint Bucks on order #{{orderNumber}}",
    bodyPlaceholder: "e.g. You have Mint Bucks available and a new order with us — don't forget to apply them!",
    testId: "printavo",
  },
];

/** Edit the custom verbiage for manual issue, manual reminder, and new-order notification emails. */
export function ManualEmailDialog({ open, onOpenChange }: ManualEmailDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetEmailTemplates({
    query: { queryKey: getGetEmailTemplatesQueryKey(), enabled: open },
  });
  const updateTemplates = useUpdateEmailTemplates();

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    for (const s of SECTIONS) {
      next[s.subjectField] = data?.[s.subjectField] ?? "";
      next[s.bodyField] = data?.[s.bodyField] ?? "";
    }
    setValues(next);
  }, [open, data]);

  function handleSave() {
    const payload = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v.trim() || null]),
    );
    updateTemplates.mutate(
      { data: payload },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetEmailTemplatesQueryKey() });
          toast({ title: "Email templates updated" });
          onOpenChange(false);
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Email Templates</DialogTitle>
          <DialogDescription>
            Customize the wording of these emails. Leave fields blank to use the standard wording. {PLACEHOLDER_HINT}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {SECTIONS.map((s) => (
            <div key={s.testId} className="rounded-md border border-border p-3 space-y-2">
              <div>
                <Label className="text-sm">{s.title}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{s.hint}</p>
              </div>
              <Input
                placeholder={s.subjectPlaceholder}
                value={values[s.subjectField] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [s.subjectField]: e.target.value }))}
                maxLength={300}
                disabled={isLoading}
                data-testid={`input-${s.testId}-subject`}
              />
              <Textarea
                placeholder={s.bodyPlaceholder}
                value={values[s.bodyField] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [s.bodyField]: e.target.value }))}
                rows={4}
                maxLength={5000}
                disabled={isLoading}
                data-testid={`textarea-${s.testId}-body`}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateTemplates.isPending || isLoading} data-testid="button-save-email-templates">
            {updateTemplates.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
