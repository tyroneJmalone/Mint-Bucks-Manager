import { logger } from "./logger";

export interface PrintavoConfig {
  apiKey: string;
  email: string;
  shopUrl?: string;
}

export interface PrintavoCustomer {
  id: string;
  fullName: string;
  email: string;
  primaryPhone?: string | null;
  /** Company name from the contact's parent Customer record in Printavo. */
  companyName: string | null;
}

export interface PrintavoOrder {
  id: string;
  visualId: string;
  orderId?: string | null;
  createdAt: string;
  total?: number | null;
  customer: PrintavoCustomer;
}

export interface PrintavoPaidInvoice {
  id: string;
  visualId: string;
  createdAt: string;
  total: number | null;
  amountPaid: number | null;
  tags: string[];
  statusId: string | null;
  statusName: string | null;
  productionDueAt: string | null;
  customerDueAt: string | null;
  customer: PrintavoCustomer;
  /** Whether this order is still a Quote (pre-approval) or an Invoice. */
  stage: "quote" | "invoice";
  /** Order nickname from Printavo (free-text job title). */
  nickname: string | null;
  /**
   * Date (YYYY-MM-DD) of the most recent Payment transaction, or null if no
   * payments exist. Printavo has no "paidAt" field on orders, so this is
   * derived from the transactions connection.
   */
  datePaid: string | null;
  /** Email of the internal Printavo user who owns the order, if any. */
  ownerEmail: string | null;
  /** Display name of the internal Printavo user who owns the order, if any. */
  ownerName: string | null;
}

const PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";

// Printavo caps connection page size at 25 regardless of the `first` argument.
const PAGE_SIZE = 25;

// Printavo rate limit: 10 requests per 5 seconds per email/IP. We serialize all
// requests through a single gate spaced at least MIN_INTERVAL_MS apart so that
// concurrent callers (poller + manual sync) never trip a 429. 620ms ≈ 8 req/5s,
// leaving headroom under the cap (550ms ≈ 9.1 req/5s proved close enough to
// trip 429s during startup bursts).
const MIN_INTERVAL_MS = 620;
// If Printavo still rate-limits us (e.g. requests from outside this process
// share the same email/IP budget), wait out the window and retry once instead
// of failing the whole scan.
const RATE_LIMIT_RETRY_MS = 5200;
let requestGate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttle(): Promise<void> {
  requestGate = requestGate.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  return requestGate;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RawContact {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  // Parent Customer record; Printavo stores the company name there, not on
  // the Contact itself.
  customer?: { companyName: string | null } | null;
}

interface RawOrder {
  id: string;
  visualId: string | null;
  nickname: string | null;
  total: number | null;
  timestamps: { createdAt: string } | null;
  contact: RawContact | null;
}

interface RawTransactionNode {
  __typename: string;
  // Only present on Payment nodes (YYYY-MM-DD).
  transactionDate?: string | null;
}

interface RawInvoice {
  id: string;
  visualId: string | null;
  nickname: string | null;
  total: number | null;
  amountPaid: number | null;
  tags: string[] | null;
  status: { id: string; name: string } | null;
  timestamps: { createdAt: string } | null;
  dueAt: string | null;
  customerDueAt: string | null;
  contact: RawContact | null;
  transactions: { nodes: RawTransactionNode[] } | null;
  owner: { id: string; email: string | null; name: string | null } | null;
}

function buildHeaders(config: PrintavoConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "email": config.email,
    "token": config.apiKey,
  };
}

async function gql<T>(config: PrintavoConfig, query: string, variables?: Record<string, unknown>): Promise<T> {
  await throttle();

  let res = await fetch(PRINTAVO_ENDPOINT, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    logger.warn("Printavo rate limit hit; retrying after cooldown");
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
    await throttle();
    res = await fetch(PRINTAVO_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify({ query, variables }),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Printavo API returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { data?: T; errors?: { message: string }[] };

  if (json.errors?.length) {
    throw new Error(`Printavo GraphQL error: ${json.errors.map(e => e.message).join("; ")}`);
  }

  return json.data as T;
}

function mapContact(c: RawContact): PrintavoCustomer {
  return {
    id: c.id,
    fullName: c.fullName ?? "",
    email: (c.email ?? "").toLowerCase().trim(),
    primaryPhone: c.phone ?? null,
    companyName: c.customer?.companyName?.trim() || null,
  };
}

function mapOrder(o: RawOrder): PrintavoOrder {
  return {
    id: o.id,
    visualId: o.visualId ?? o.id,
    orderId: o.nickname ?? null,
    createdAt: o.timestamps?.createdAt ?? new Date(0).toISOString(),
    total: o.total ?? null,
    customer: mapContact(o.contact ?? { id: "", fullName: null, email: null, phone: null }),
  };
}

export async function testConnection(config: PrintavoConfig): Promise<{ success: boolean; message: string }> {
  try {
    await gql(config, `query { account { __typename } }`);
    return { success: true, message: "Connected to Printavo successfully" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "Printavo connection test failed");
    return { success: false, message: msg };
  }
}

const CONTACT_FIELDS = `id fullName email phone customer { companyName }`;

export async function fetchAllCustomers(config: PrintavoConfig): Promise<PrintavoCustomer[]> {
  const all: PrintavoCustomer[] = [];
  let after: string | undefined;
  let pages = 0;
  const MAX_PAGES = 500;

  while (pages < MAX_PAGES) {
    const data = await gql<{ contacts: { nodes: RawContact[]; pageInfo: PageInfo } }>(config, `
      query GetContacts($first: Int!, $after: String) {
        contacts(first: $first, after: $after) {
          nodes { ${CONTACT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: PAGE_SIZE, after });

    for (const node of data.contacts.nodes) {
      all.push(mapContact(node));
    }

    pages++;
    const { hasNextPage, endCursor } = data.contacts.pageInfo;
    if (!hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return all;
}

// Printavo's `orders` field is a union (OrderUnion) of Quote and Invoice. A job
// enters Printavo as a Quote and becomes an Invoice once approved. Polling the
// union means we notify a customer as soon as the order is created (at quote
// stage), not only after approval — polling `invoices` alone sent nothing for a
// brand-new quote. You cannot select fields directly on the union, so both
// members are spread with inline fragments below.
const ORDER_FIELDS = `
  __typename
  ... on Quote {
    id
    visualId
    nickname
    total
    timestamps { createdAt }
    contact { ${CONTACT_FIELDS} }
  }
  ... on Invoice {
    id
    visualId
    nickname
    total
    timestamps { createdAt }
    contact { ${CONTACT_FIELDS} }
  }
`;

export async function fetchRecentOrders(config: PrintavoConfig, sinceIso: string): Promise<PrintavoOrder[]> {
  const since = new Date(sinceIso).getTime();
  const all: PrintavoOrder[] = [];
  let after: string | undefined;
  let pages = 0;
  const MAX_PAGES = 40;

  // Sort by VISUAL_ID descending — visual IDs increment sequentially, so this
  // surfaces the newest orders (quotes and invoices) first. We stop paging once
  // we reach orders created before `since`.
  while (pages < MAX_PAGES) {
    const data = await gql<{ orders: { nodes: RawOrder[]; pageInfo: PageInfo } }>(config, `
      query GetRecentOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortOn: VISUAL_ID, sortDescending: true) {
          nodes { ${ORDER_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: PAGE_SIZE, after });

    let reachedOlder = false;
    for (const node of data.orders.nodes) {
      const order = mapOrder(node);
      if (new Date(order.createdAt).getTime() >= since) {
        all.push(order);
      } else {
        reachedOlder = true;
      }
    }

    pages++;
    const { hasNextPage, endCursor } = data.orders.pageInfo;
    if (reachedOlder || !hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return all;
}

// Latest Payment transactionDate (YYYY-MM-DD strings compare correctly
// lexicographically). Refunds/voids/disputes are ignored.
function latestPaymentDate(inv: RawInvoice): string | null {
  let latest: string | null = null;
  for (const t of inv.transactions?.nodes ?? []) {
    if (t.__typename !== "Payment" || !t.transactionDate) continue;
    if (!latest || t.transactionDate > latest) latest = t.transactionDate;
  }
  return latest;
}

function mapInvoice(inv: RawInvoice, stage: "quote" | "invoice" = "invoice"): PrintavoPaidInvoice {
  return {
    id: inv.id,
    visualId: inv.visualId ?? inv.id,
    createdAt: inv.timestamps?.createdAt ?? new Date(0).toISOString(),
    total: inv.total ?? null,
    amountPaid: inv.amountPaid ?? null,
    tags: Array.isArray(inv.tags) ? inv.tags : [],
    statusId: inv.status?.id ?? null,
    statusName: inv.status?.name ?? null,
    productionDueAt: inv.dueAt ?? null,
    customerDueAt: inv.customerDueAt ?? null,
    customer: mapContact(inv.contact ?? { id: "", fullName: null, email: null, phone: null }),
    stage,
    nickname: inv.nickname ?? null,
    datePaid: latestPaymentDate(inv),
    ownerEmail: inv.owner?.email?.toLowerCase().trim() || null,
    ownerName: inv.owner?.name ?? null,
  };
}

const PAID_INVOICE_FIELDS = `
  id
  visualId
  nickname
  total
  amountPaid
  tags
  status { id name }
  timestamps { createdAt }
  dueAt
  customerDueAt
  contact { ${CONTACT_FIELDS} }
  transactions(first: 25) { nodes { __typename ... on Payment { transactionDate } } }
  owner { id email name }
`;

// Printavo's server-side payment filter. `PARTIAL_PAYMENT` covers invoices with a
// deposit but an outstanding balance (see printavo-api-v2.md).
export type PrintavoPaymentStatus = "UNPAID" | "PARTIAL_PAYMENT" | "PAID";

// Fetch invoices with a given payment status, newest first. Printavo exposes no
// "paidAt" and no created/updated sort, so we page by VISUAL_ID desc (≈ creation
// order) and stop once we reach invoices created before `sinceMs`.
export async function fetchInvoicesByPaymentStatus(
  config: PrintavoConfig,
  paymentStatus: PrintavoPaymentStatus,
  sinceMs: number,
  maxPages = 80,
): Promise<PrintavoPaidInvoice[]> {
  const all: PrintavoPaidInvoice[] = [];
  let after: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const data = await gql<{ invoices: { nodes: RawInvoice[]; pageInfo: PageInfo } }>(config, `
      query GetInvoicesByPaymentStatus($first: Int!, $after: String) {
        invoices(first: $first, after: $after, paymentStatus: ${paymentStatus}, sortOn: VISUAL_ID, sortDescending: true) {
          nodes { ${PAID_INVOICE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: PAGE_SIZE, after });

    let reachedOlder = false;
    for (const node of data.invoices.nodes) {
      const createdMs = node.timestamps?.createdAt ? new Date(node.timestamps.createdAt).getTime() : 0;
      if (createdMs >= sinceMs) {
        all.push(mapInvoice(node));
      } else {
        reachedOlder = true;
      }
    }

    pages++;
    const { hasNextPage, endCursor } = data.invoices.pageInfo;
    if (reachedOlder || !hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return all;
}

// Fetch invoices that are fully paid, newest first. The rewards ledger dedups by
// (ruleId, invoiceId), so re-scanning overlapping windows each poll is harmless.
// Invoices paid long after creation (older than the caller's lookback window) are
// intentionally not revisited.
export async function fetchPaidInvoices(
  config: PrintavoConfig,
  sinceMs: number,
  maxPages = 80,
): Promise<PrintavoPaidInvoice[]> {
  return fetchInvoicesByPaymentStatus(config, "PAID", sinceMs, maxPages);
}

// Raw node from the `orders` union query, spread with identical field sets on
// both members plus __typename so we can tell quotes from invoices.
interface RawOrderUnionNode extends RawInvoice {
  __typename: "Quote" | "Invoice";
}

// Fetch open quotes (orders that haven't been approved into invoices yet),
// newest first. The `invoices` query never returns quotes — a job enters
// Printavo as a Quote and only becomes an Invoice on approval — so the rewards
// pipeline must scan the `orders` union to see not-yet-approved work. Invoice
// nodes are skipped here (they're covered by the paymentStatus queries).
export async function fetchOpenQuotes(
  config: PrintavoConfig,
  sinceMs: number,
  maxPages = 40,
): Promise<PrintavoPaidInvoice[]> {
  const all: PrintavoPaidInvoice[] = [];
  let after: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const data = await gql<{ orders: { nodes: RawOrderUnionNode[]; pageInfo: PageInfo } }>(config, `
      query GetOpenQuotes($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortOn: VISUAL_ID, sortDescending: true) {
          nodes {
            __typename
            ... on Quote { ${PAID_INVOICE_FIELDS} }
            ... on Invoice { ${PAID_INVOICE_FIELDS} }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: PAGE_SIZE, after });

    let reachedOlder = false;
    for (const node of data.orders.nodes) {
      const createdMs = node.timestamps?.createdAt ? new Date(node.timestamps.createdAt).getTime() : 0;
      if (createdMs < sinceMs) {
        reachedOlder = true;
        continue;
      }
      if (node.__typename !== "Quote") continue;
      // A quote already paid in full (rare, e.g. pre-paid) isn't "pipeline".
      const total = node.total ?? 0;
      if (total > 0 && (node.amountPaid ?? 0) >= total) continue;
      all.push(mapInvoice(node, "quote"));
    }

    pages++;
    const { hasNextPage, endCursor } = data.orders.pageInfo;
    if (reachedOlder || !hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return all;
}

// Fetch orders that are in the pipeline (not yet fully paid) for the rewards
// forecast: open quotes plus unpaid / partially-paid invoices. Three paged
// queries, merged. Capped at a smaller page budget since this runs on-demand
// behind the shared request gate.
export async function fetchPipelineInvoices(
  config: PrintavoConfig,
  sinceMs: number,
  maxPages = 40,
): Promise<PrintavoPaidInvoice[]> {
  const [quotes, unpaid, partial] = await Promise.all([
    fetchOpenQuotes(config, sinceMs, maxPages),
    fetchInvoicesByPaymentStatus(config, "UNPAID", sinceMs, maxPages),
    fetchInvoicesByPaymentStatus(config, "PARTIAL_PAYMENT", sinceMs, maxPages),
  ]);
  return [...quotes, ...unpaid, ...partial];
}

export async function fetchOrderByNumber(config: PrintavoConfig, orderNumber: string): Promise<PrintavoOrder | null> {
  try {
    const data = await gql<{ orders: { nodes: RawOrder[] } }>(config, `
      query GetOrderByNumber($query: String, $first: Int!) {
        orders(query: $query, first: $first) {
          nodes { ${ORDER_FIELDS} }
        }
      }
    `, { query: orderNumber, first: 10 });

    // Only return an exact visualId match. A `query` search can also match on
    // nickname/PO, so falling back to the first result could present the wrong
    // order as if it were the requested one.
    const exact = data.orders.nodes.find(n => n.visualId === orderNumber);
    return exact ? mapOrder(exact) : null;
  } catch (err) {
    logger.warn({ err, orderNumber }, "Failed to fetch Printavo order by number");
    return null;
  }
}
