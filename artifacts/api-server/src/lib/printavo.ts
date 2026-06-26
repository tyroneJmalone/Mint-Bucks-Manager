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

export interface PrintavoPaginatedResult<T> {
  records: T[];
  metadata: {
    currentPage: number;
    totalPages: number;
    totalCount: number;
  };
}

const PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";

const ORDERS_FRAGMENT = `
  records {
    id
    visualId
    orderId
    createdAt
    total
    customer {
      id
      fullName
      email
      primaryPhone
    }
  }
  metadata {
    currentPage
    totalPages
    totalCount
  }
`;

function buildHeaders(config: PrintavoConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "email": config.email,
    "token": config.apiKey,
  };
}

async function gql<T>(config: PrintavoConfig, query: string, variables?: Record<string, unknown>): Promise<T> {
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

export async function testConnection(config: PrintavoConfig): Promise<{ success: boolean; message: string }> {
  try {
    await gql(config, `query { account { id email } }`);
    return { success: true, message: "Connected successfully" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "Printavo connection test failed");
    return { success: false, message: msg };
  }
}

export async function fetchCustomers(config: PrintavoConfig, page = 1): Promise<PrintavoPaginatedResult<PrintavoCustomer>> {
  const data = await gql<{ customers: PrintavoPaginatedResult<PrintavoCustomer> }>(config, `
    query GetCustomers($page: Int) {
      customers(page: $page) {
        records {
          id
          fullName
          email
          primaryPhone
        }
        metadata {
          currentPage
          totalPages
          totalCount
        }
      }
    }
  `, { page });
  return data.customers;
}

export async function fetchAllCustomers(config: PrintavoConfig): Promise<PrintavoCustomer[]> {
  const all: PrintavoCustomer[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await fetchCustomers(config, page);
    all.push(...result.records);
    totalPages = result.metadata.totalPages;
    page++;
    if (page > 50) break;
  }

  return all;
}

export async function fetchRecentOrders(config: PrintavoConfig, sinceIso: string): Promise<PrintavoOrder[]> {
  const since = new Date(sinceIso).getTime();
  const all: PrintavoOrder[] = [];
  let page = 1;
  let totalPages = 1;
  const PAGE_LIMIT = 20;

  while (page <= totalPages && page <= PAGE_LIMIT) {
    const data = await gql<{ quotes: PrintavoPaginatedResult<PrintavoOrder> }>(config, `
      query GetRecentOrders($page: Int) {
        quotes(page: $page, sortOn: CREATED_AT, direction: DESCENDING) {
          ${ORDERS_FRAGMENT}
        }
      }
    `, { page });

    const { records, metadata } = data.quotes;
    totalPages = metadata.totalPages;

    let reachedOlder = false;
    for (const order of records) {
      if (new Date(order.createdAt).getTime() >= since) {
        all.push(order);
      } else {
        reachedOlder = true;
      }
    }

    if (reachedOlder) break;
    page++;
  }

  return all;
}

export async function fetchOrderByNumber(config: PrintavoConfig, orderNumber: string): Promise<PrintavoOrder | null> {
  try {
    const data = await gql<{ quotes: { records: PrintavoOrder[] } }>(config, `
      query GetOrderByNumber($visualId: String) {
        quotes(visualId: $visualId) {
          records {
            id
            visualId
            orderId
            createdAt
            total
            customer {
              id
              fullName
              email
              primaryPhone
            }
          }
        }
      }
    `, { visualId: orderNumber });

    return data.quotes.records[0] ?? null;
  } catch (err) {
    logger.warn({ err, orderNumber }, "Failed to fetch Printavo order by number");
    return null;
  }
}
