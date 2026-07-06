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

interface RawOrder {
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
