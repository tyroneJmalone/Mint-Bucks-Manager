import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  useCreateRewardRule,
  useUpdateRewardRule,
  getListRewardRulesQueryKey,
  type RewardRule,
  type RewardRuleInput,
  type RewardParams,
  type RewardConditions,
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type RewardType = RewardRuleInput["rewardType"];

interface TierRow {
  minAmount: string;
  rewardAmount: string;
}

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: RewardRule | null;
}

const REWARD_TYPE_OPTIONS: { value: RewardType; label: string; hint: string }[] = [
  { value: "flat", label: "Flat amount", hint: "Award a fixed dollar amount per qualifying invoice." },
  { value: "percent_paid", label: "Percent of amount paid", hint: "Award a percentage of the total the customer paid." },
  { value: "percent_total", label: "Percent of order total", hint: "Award a percentage of the invoice total." },
  { value: "tiered", label: "Tiered by order total", hint: "Award different amounts based on the order total." },
];

function toCsv(arr?: string[] | null) {
  return arr && arr.length ? arr.join(", ") : "";
}
function fromCsv(s: string): string[] {
  return s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
function toDateInput(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function RuleFormDialog({ open, onOpenChange, rule }: RuleFormDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!rule;

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rewardType, setRewardType] = useState<RewardType>("percent_paid");
  const [flatAmount, setFlatAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [tiers, setTiers] = useState<TierRow[]>([{ minAmount: "", rewardAmount: "" }]);

  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const [showConditions, setShowConditions] = useState(false);
  const [totalMin, setTotalMin] = useState("");
  const [totalMax, setTotalMax] = useState("");
  const [statusNameAny, setStatusNameAny] = useState("");
  const [tagAny, setTagAny] = useState("");
  const [invoiceDateFrom, setInvoiceDateFrom] = useState("");
  const [invoiceDateTo, setInvoiceDateTo] = useState("");
  const [productionDateFrom, setProductionDateFrom] = useState("");
  const [productionDateTo, setProductionDateTo] = useState("");

  useEffect(() => {
    if (!open) return;
    if (rule) {
      setName(rule.name);
      setEnabled(rule.enabled);
      setRewardType(rule.rewardType);
      setFlatAmount(rule.rewardParams.flatAmount != null ? String(rule.rewardParams.flatAmount) : "");
      setPercent(rule.rewardParams.percent != null ? String(rule.rewardParams.percent) : "");
      setTiers(
        rule.rewardParams.tiers && rule.rewardParams.tiers.length
          ? rule.rewardParams.tiers.map((t) => ({
              minAmount: String(t.minAmount),
              rewardAmount: String(t.rewardAmount),
            }))
          : [{ minAmount: "", rewardAmount: "" }],
      );
      setStartsAt(toDateInput(rule.startsAt));
      setEndsAt(toDateInput(rule.endsAt));
      const c = rule.conditions ?? {};
      setTotalMin(c.totalMin != null ? String(c.totalMin) : "");
      setTotalMax(c.totalMax != null ? String(c.totalMax) : "");
      setStatusNameAny(toCsv(c.statusNameAny));
      setTagAny(toCsv(c.tagAny));
      setInvoiceDateFrom(toDateInput(c.invoiceDateFrom));
      setInvoiceDateTo(toDateInput(c.invoiceDateTo));
      setProductionDateFrom(toDateInput(c.productionDateFrom));
      setProductionDateTo(toDateInput(c.productionDateTo));
      setShowConditions(
        c.totalMin != null ||
          c.totalMax != null ||
          !!c.statusNameAny?.length ||
          !!c.tagAny?.length ||
          !!c.invoiceDateFrom ||
          !!c.invoiceDateTo ||
          !!c.productionDateFrom ||
          !!c.productionDateTo,
      );
    } else {
      setName("");
      setEnabled(true);
      setRewardType("percent_paid");
      setFlatAmount("");
      setPercent("");
      setTiers([{ minAmount: "", rewardAmount: "" }]);
      setStartsAt("");
      setEndsAt("");
      setShowConditions(false);
      setTotalMin("");
      setTotalMax("");
      setStatusNameAny("");
      setTagAny("");
      setInvoiceDateFrom("");
      setInvoiceDateTo("");
      setProductionDateFrom("");
      setProductionDateTo("");
    }
  }, [open, rule]);

  const createRule = useCreateRewardRule();
  const updateRule = useUpdateRewardRule();
  const isPending = createRule.isPending || updateRule.isPending;

  function buildParams(): RewardParams {
    if (rewardType === "flat") return { flatAmount: parseFloat(flatAmount) };
    if (rewardType === "percent_paid" || rewardType === "percent_total")
      return { percent: parseFloat(percent) };
    return {
      tiers: tiers
        .filter((t) => t.minAmount !== "" || t.rewardAmount !== "")
        .map((t) => ({ minAmount: parseFloat(t.minAmount), rewardAmount: parseFloat(t.rewardAmount) })),
    };
  }

  function buildConditions(): RewardConditions {
    const c: RewardConditions = {};
    if (showConditions) {
      if (totalMin !== "") c.totalMin = parseFloat(totalMin);
      if (totalMax !== "") c.totalMax = parseFloat(totalMax);
      const s = fromCsv(statusNameAny);
      if (s.length) c.statusNameAny = s;
      const t = fromCsv(tagAny);
      if (t.length) c.tagAny = t;
      if (invoiceDateFrom) c.invoiceDateFrom = invoiceDateFrom;
      if (invoiceDateTo) c.invoiceDateTo = invoiceDateTo;
      if (productionDateFrom) c.productionDateFrom = productionDateFrom;
      if (productionDateTo) c.productionDateTo = productionDateTo;
    }
    return c;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const body: RewardRuleInput = {
      name: name.trim(),
      enabled,
      rewardType,
      rewardParams: buildParams(),
      conditions: buildConditions(),
      startsAt: startsAt || null,
      endsAt: endsAt || null,
    };

    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getListRewardRulesQueryKey() });
      toast({ title: isEdit ? "Rule updated" : "Rule created" });
      onOpenChange(false);
    };
    const onError = (err: Error) => toast({ title: err.message, variant: "destructive" });

    if (isEdit && rule) {
      updateRule.mutate({ id: String(rule.id), data: body }, { onSuccess, onError });
    } else {
      createRule.mutate({ data: body }, { onSuccess, onError });
    }
  }

  const selectedHint = REWARD_TYPE_OPTIONS.find((o) => o.value === rewardType)?.hint;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Reward Rule" : "New Reward Rule"}</DialogTitle>
          <DialogDescription>
            Rules decide how many Mint Bucks a customer earns when an invoice is fully paid.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Rule name</Label>
            <Input
              id="rule-name"
              data-testid="input-rule-name"
              placeholder="e.g. 5% back on every paid order"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Reward type</Label>
            <Select value={rewardType} onValueChange={(v) => setRewardType(v as RewardType)}>
              <SelectTrigger data-testid="select-reward-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REWARD_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedHint && <p className="text-xs text-muted-foreground">{selectedHint}</p>}
          </div>

          {rewardType === "flat" && (
            <div className="space-y-1.5">
              <Label htmlFor="flat-amount">Flat amount ($)</Label>
              <Input
                id="flat-amount"
                data-testid="input-flat-amount"
                type="number"
                min={0}
                step="0.01"
                placeholder="25.00"
                value={flatAmount}
                onChange={(e) => setFlatAmount(e.target.value)}
                className="w-40"
              />
            </div>
          )}

          {(rewardType === "percent_paid" || rewardType === "percent_total") && (
            <div className="space-y-1.5">
              <Label htmlFor="percent">Percent (%)</Label>
              <Input
                id="percent"
                data-testid="input-percent"
                type="number"
                min={0}
                max={100}
                step="0.1"
                placeholder="5"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="w-40"
              />
            </div>
          )}

          {rewardType === "tiered" && (
            <div className="space-y-2">
              <Label>Tiers</Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Order total ≥ minimum earns the matching reward. The highest matching tier wins.
              </p>
              <div className="space-y-2">
                {tiers.map((tier, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 flex-1">
                      <span className="text-xs text-muted-foreground w-20">Order ≥ $</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        data-testid={`input-tier-min-${i}`}
                        placeholder="500"
                        value={tier.minAmount}
                        onChange={(e) =>
                          setTiers((prev) =>
                            prev.map((t, j) => (j === i ? { ...t, minAmount: e.target.value } : t)),
                          )
                        }
                      />
                    </div>
                    <div className="flex items-center gap-1.5 flex-1">
                      <span className="text-xs text-muted-foreground w-16">Award $</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        data-testid={`input-tier-reward-${i}`}
                        placeholder="25"
                        value={tier.rewardAmount}
                        onChange={(e) =>
                          setTiers((prev) =>
                            prev.map((t, j) => (j === i ? { ...t, rewardAmount: e.target.value } : t)),
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={tiers.length === 1}
                      onClick={() => setTiers((prev) => prev.filter((_, j) => j !== i))}
                      data-testid={`button-remove-tier-${i}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setTiers((prev) => [...prev, { minAmount: "", rewardAmount: "" }])}
                data-testid="button-add-tier"
              >
                <Plus className="w-3.5 h-3.5" /> Add tier
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label className="text-sm">Rule enabled</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Disabled rules are skipped during scans.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="switch-rule-enabled" />
          </div>

          <div className="rounded-md border border-border p-3 space-y-3">
            <div>
              <Label className="text-sm">Active window (optional)</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Only award while this rule is within its schedule. Leave blank to always apply.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="starts-at" className="text-xs">
                  Starts
                </Label>
                <Input
                  id="starts-at"
                  type="date"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  data-testid="input-starts-at"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ends-at" className="text-xs">
                  Ends
                </Label>
                <Input
                  id="ends-at"
                  type="date"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  data-testid="input-ends-at"
                />
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setShowConditions((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium text-foreground"
              data-testid="button-toggle-conditions"
            >
              <span>Conditions {showConditions ? "" : "(optional)"}</span>
              <span className="text-xs text-muted-foreground">{showConditions ? "Hide" : "Show"}</span>
            </button>
            {showConditions && (
              <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  Only award when the invoice matches all of these. Leave blank to ignore.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="total-min" className="text-xs">
                      Order total min ($)
                    </Label>
                    <Input
                      id="total-min"
                      type="number"
                      min={0}
                      step="0.01"
                      value={totalMin}
                      onChange={(e) => setTotalMin(e.target.value)}
                      data-testid="input-total-min"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="total-max" className="text-xs">
                      Order total max ($)
                    </Label>
                    <Input
                      id="total-max"
                      type="number"
                      min={0}
                      step="0.01"
                      value={totalMax}
                      onChange={(e) => setTotalMax(e.target.value)}
                      data-testid="input-total-max"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="status-any" className="text-xs">
                    Invoice status is any of
                  </Label>
                  <Input
                    id="status-any"
                    placeholder="Comma-separated, e.g. Complete, Shipped"
                    value={statusNameAny}
                    onChange={(e) => setStatusNameAny(e.target.value)}
                    data-testid="input-status-any"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tag-any" className="text-xs">
                    Invoice has any tag
                  </Label>
                  <Input
                    id="tag-any"
                    placeholder="Comma-separated, e.g. wholesale, rush"
                    value={tagAny}
                    onChange={(e) => setTagAny(e.target.value)}
                    data-testid="input-tag-any"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="invoice-date-from" className="text-xs">
                      Invoice created from
                    </Label>
                    <Input
                      id="invoice-date-from"
                      type="date"
                      value={invoiceDateFrom}
                      onChange={(e) => setInvoiceDateFrom(e.target.value)}
                      data-testid="input-invoice-date-from"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="invoice-date-to" className="text-xs">
                      Invoice created to
                    </Label>
                    <Input
                      id="invoice-date-to"
                      type="date"
                      value={invoiceDateTo}
                      onChange={(e) => setInvoiceDateTo(e.target.value)}
                      data-testid="input-invoice-date-to"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="production-date-from" className="text-xs">
                      Production due from
                    </Label>
                    <Input
                      id="production-date-from"
                      type="date"
                      value={productionDateFrom}
                      onChange={(e) => setProductionDateFrom(e.target.value)}
                      data-testid="input-production-date-from"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="production-date-to" className="text-xs">
                      Production due to
                    </Label>
                    <Input
                      id="production-date-to"
                      type="date"
                      value={productionDateTo}
                      onChange={(e) => setProductionDateTo(e.target.value)}
                      data-testid="input-production-date-to"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} data-testid="button-save-rule">
              {isPending ? "Saving…" : isEdit ? "Save Rule" : "Create Rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
