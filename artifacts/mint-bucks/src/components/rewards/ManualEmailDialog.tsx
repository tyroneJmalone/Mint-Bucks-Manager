import { useEffect, useState } from "react";
import {
  useGetManualEmailTemplate,
  useUpdateManualEmailTemplate,
  getGetManualEmailTemplateQueryKey,
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

/** Edit the custom verbiage used for manually issued credit emails. */
export function ManualEmailDialog({ open, onOpenChange }: ManualEmailDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetManualEmailTemplate({
    query: { queryKey: getGetManualEmailTemplateQueryKey(), enabled: open },
  });
  const updateTemplate = useUpdateManualEmailTemplate();

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) return;
    setSubject(data?.issuedEmailSubject ?? "");
    setBody(data?.issuedEmailBody ?? "");
  }, [open, data]);

  function handleSave() {
    updateTemplate.mutate(
      { data: { issuedEmailSubject: subject.trim() || null, issuedEmailBody: body.trim() || null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetManualEmailTemplateQueryKey() });
          toast({ title: "Manual issue email updated" });
          onOpenChange(false);
        },
        onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manual Issue Email</DialogTitle>
          <DialogDescription>
            Customize the email sent when you issue Mint Bucks manually from the Issue page. Leave fields blank to
            use the standard wording. {PLACEHOLDER_HINT}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="manual-email-subject">Subject</Label>
            <Input
              id="manual-email-subject"
              placeholder="e.g. You've received {{amount}} in Mint Bucks!"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={300}
              disabled={isLoading}
              data-testid="input-manual-email-subject"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-email-body">Message</Label>
            <Textarea
              id="manual-email-body"
              placeholder="e.g. We've added {{amount}} in Mint Bucks to your account as a thank-you."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={5000}
              disabled={isLoading}
              data-testid="textarea-manual-email-body"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateTemplate.isPending || isLoading} data-testid="button-save-manual-email">
            {updateTemplate.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
