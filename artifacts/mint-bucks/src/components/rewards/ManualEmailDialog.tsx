import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import {
  useGetEmailTemplates,
  useUpdateEmailTemplates,
  useSendTestRewardEmail,
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
  imageField: "issuedEmailImage" | "reminderEmailImage" | "printavoEmailImage";
  emailType: "issued" | "reminder" | "printavo_notification";
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
    imageField: "issuedEmailImage",
    emailType: "issued",
    title: "Manual issue email",
    hint: "Sent when you issue Mint Bucks by hand from the Issue page.",
    subjectPlaceholder: "e.g. You've received {{amount}} in Mint Bucks!",
    bodyPlaceholder: "e.g. We've added {{amount}} in Mint Bucks to your account as a thank-you.",
    testId: "manual-issue",
  },
  {
    subjectField: "reminderEmailSubject",
    bodyField: "reminderEmailBody",
    imageField: "reminderEmailImage",
    emailType: "reminder",
    title: "Manual reminder email",
    hint: "Sent when you click \"Send Reminder\" on a credit.",
    subjectPlaceholder: "e.g. Don't forget your {{amount}} in Mint Bucks",
    bodyPlaceholder: "e.g. Just a reminder — you still have {{amount}} in Mint Bucks to use on your next order.",
    testId: "manual-reminder",
  },
  {
    subjectField: "printavoEmailSubject",
    bodyField: "printavoEmailBody",
    imageField: "printavoEmailImage",
    emailType: "printavo_notification",
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
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [testEmail, setTestEmail] = useState("");
  const sendTestEmail = useSendTestRewardEmail();

  // One shared uploader: the file input that triggered the upload records
  // which section's image field the result belongs to.
  const uploadTargetRef = useRef<SectionDef["imageField"] | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const { uploadFile, isUploading } = useUpload({
    onSuccess: async (response) => {
      const target = uploadTargetRef.current;
      uploadTargetRef.current = null;
      if (!target) return;
      try {
        // Mark the fresh upload publicly readable so the in-dialog preview and
        // unsaved "Send test" emails can display it immediately.
        const res = await fetch("/api/storage/uploads/finalize-email-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objectPath: response.objectPath }),
        });
        if (!res.ok) throw new Error("Failed to finalize image");
        const { objectPath } = (await res.json()) as { objectPath: string };
        setImages((prev) => ({ ...prev, [target]: objectPath }));
      } catch (err) {
        toast({ title: "Image upload failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      }
    },
    onError: (err) => {
      uploadTargetRef.current = null;
      toast({ title: "Image upload failed", description: err.message, variant: "destructive" });
    },
  });

  function handleSendTest(section: SectionDef) {
    if (!testEmail.trim()) {
      toast({ title: "Enter an email address at the bottom to send tests to", variant: "destructive" });
      return;
    }
    sendTestEmail.mutate(
      {
        data: {
          emailType: section.emailType,
          recipientEmail: testEmail.trim(),
          amount: 25,
          customSubject: (values[section.subjectField] ?? "").trim() || null,
          customBody: (values[section.bodyField] ?? "").trim() || null,
          imageObjectPath: images[section.imageField] ?? null,
        },
      },
      {
        onSuccess: () => toast({ title: `Test email sent to ${testEmail.trim()}` }),
        onError: () => toast({ title: "Failed to send test email", description: "Check that your sending domain is verified in Resend.", variant: "destructive" }),
      },
    );
  }

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    const nextImages: Record<string, string | null> = {};
    for (const s of SECTIONS) {
      next[s.subjectField] = data?.[s.subjectField] ?? "";
      next[s.bodyField] = data?.[s.bodyField] ?? "";
      nextImages[s.imageField] = data?.[s.imageField] ?? null;
    }
    setValues(next);
    setImages(nextImages);
  }, [open, data]);

  function handleSave() {
    const payload = {
      ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() || null])),
      ...images,
    };
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
              <input
                ref={(el) => { fileInputRefs.current[s.imageField] = el; }}
                type="file"
                accept="image/*"
                className="hidden"
                data-testid={`input-${s.testId}-image-file`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    uploadTargetRef.current = s.imageField;
                    uploadFile(file);
                  }
                  e.target.value = "";
                }}
              />
              {images[s.imageField] ? (
                <div className="flex items-center gap-3">
                  <img
                    src={`/api/storage${images[s.imageField]}`}
                    alt="Email image"
                    className="h-16 w-16 rounded-md object-cover border border-border"
                    data-testid={`img-${s.testId}-image-preview`}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isUploading}
                      onClick={() => { fileInputRefs.current[s.imageField]?.click(); }}
                      data-testid={`button-${s.testId}-replace-image`}
                    >
                      {isUploading ? "Uploading…" : "Replace image"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setImages((prev) => ({ ...prev, [s.imageField]: null }))}
                      data-testid={`button-${s.testId}-remove-image`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isUploading}
                  onClick={() => { fileInputRefs.current[s.imageField]?.click(); }}
                  data-testid={`button-${s.testId}-upload-image`}
                >
                  {isUploading && uploadTargetRef.current === s.imageField ? "Uploading…" : "Upload image (optional)"}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={sendTestEmail.isPending}
                onClick={() => handleSendTest(s)}
                data-testid={`button-test-${s.testId}`}
              >
                <Send className="w-3.5 h-3.5" /> Send test
              </Button>
            </div>
          ))}
          <div className="rounded-md border border-border p-3 space-y-2">
            <div>
              <Label className="text-sm">Send tests to</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Test emails use the wording currently in this window (even unsaved) with sample data — a $25.00 balance and order #1234. No credit is created.
              </p>
            </div>
            <Input
              type="email"
              placeholder="you@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              data-testid="input-templates-test-email"
            />
          </div>
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
