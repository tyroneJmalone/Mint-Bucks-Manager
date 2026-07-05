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
}

export interface PrintavoOrder {
  id: string;
  visualId: string;
  orderId?: string | null;
  createdAt: string;
  total?: number | null;
  customer: PrintavoCustomer;
}

const PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";

// Printavo caps connection page size at 25 regardless of the `first` argument.
const PAGE_SIZE = 25;

// Printavo rate limit: 10 requests per 5 seconds per email/IP. We serialize all
// requests through a single gate spaced at least MIN_INTERVAL_MS apart so that
// concurrent callers (poller + manual sync) never trip a 429.
const MIN_INTERVAL_MS = 550;
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
}

interface RawInvoice {
  id: string;
  visualId: string | null;
  nickname: string | null;
  total: number | null;
  timestamps: { createdAt: string } | null;
  contact: RawContact | null;
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

  const res = await fetch(PRINTAVO_ENDPOINT, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify({ query, variables }),
  });

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
  };
}

function mapInvoice(inv: RawInvoice): PrintavoOrder {
  return {
    id: inv.id,
    visualId: inv.visualId ?? inv.id,
    orderId: inv.nickname ?? null,
    createdAt: inv.timestamps?.createdAt ?? new Date(0).toISOString(),
    total: inv.total ?? null,
    customer: mapContact(inv.contact ?? { id: "", fullName: null, email: null, phone: null }),
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

const CONTACT_FIELDS = `id fullName email phone`;

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

const INVOICE_FIELDS = `
  id
  visualId
  nickname
  total
  timestamps { createdAt }
  contact { ${CONTACT_FIELDS} }
`;

export async function fetchRecentOrders(config: PrintavoConfig, sinceIso: string): Promise<PrintavoOrder[]> {
  const since = new Date(sinceIso).getTime();
  const all: PrintavoOrder[] = [];
  let after: string | undefined;
  let pages = 0;
  const MAX_PAGES = 40;

  // Sort by VISUAL_ID descending — visual IDs increment sequentially, so this
  // surfaces the newest invoices first. We stop paging once we reach invoices
  // created before `since`.
  while (pages < MAX_PAGES) {
    const data = await gql<{ invoices: { nodes: RawInvoice[]; pageInfo: PageInfo } }>(config, `
      query GetRecentOrders($first: Int!, $after: String) {
        invoices(first: $first, after: $after, sortOn: VISUAL_ID, sortDescending: true) {
          nodes { ${INVOICE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: PAGE_SIZE, after });

    let reachedOlder = false;
    for (const inv of data.invoices.nodes) {
      const order = mapInvoice(inv);
      if (new Date(order.createdAt).getTime() >= since) {
        all.push(order);
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

export async function fetchOrderByNumber(config: PrintavoConfig, orderNumber: string): Promise<PrintavoOrder | null> {
  try {
    const data = await gql<{ invoices: { nodes: RawInvoice[] } }>(config, `
      query GetOrderByNumber($query: String, $first: Int!) {
        invoices(query: $query, first: $first) {
          nodes { ${INVOICE_FIELDS} }
        }
      }
    `, { query: orderNumber, first: 10 });

    // Only return an exact visualId match. A `query` search can also match on
    // nickname/PO, so falling back to the first result could present the wrong
    // order as if it were the requested one.
    const exact = data.invoices.nodes.find(n => n.visualId === orderNumber);
    return exact ? mapInvoice(exact) : null;
  } catch (err) {
    logger.warn({ err, orderNumber }, "Failed to fetch Printavo order by number");
    return null;
  }
}
