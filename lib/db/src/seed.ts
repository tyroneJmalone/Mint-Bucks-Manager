import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { customersTable, creditsTable, redemptionsTable } from "./schema/index.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function seed() {
  console.log("Seeding demo data...");

  const existingCustomers = await db.select().from(customersTable).limit(1);
  if (existingCustomers.length > 0) {
    console.log("Data already exists — skipping seed (run truncate manually to reset).");
    await pool.end();
    return;
  }

  const customers = await db.insert(customersTable).values([
    { name: "Sarah Chen", email: "sarah.chen@example.com", phone: "555-0101" },
    { name: "Marcus Williams", email: "marcus.w@example.com", phone: "555-0102" },
    { name: "Priya Patel", email: "priya.patel@example.com", phone: "555-0103" },
    { name: "Tom Erikson", email: "tom.e@example.com", phone: null },
    { name: "Olivia Santos", email: "olivia.s@example.com", phone: "555-0105" },
  ]).returning();

  console.log(`Inserted ${customers.length} customers`);

  const now = new Date();
  const pastMonth = new Date(now); pastMonth.setMonth(now.getMonth() - 1);
  const twoMonthsAgo = new Date(now); twoMonthsAgo.setMonth(now.getMonth() - 2);
  const in30Days = new Date(now); in30Days.setDate(now.getDate() + 30);
  const in10Days = new Date(now); in10Days.setDate(now.getDate() + 10);

  await db.insert(creditsTable).values({ customerId: customers[0].id, code: "MB-A1B2C3D4", amount: "75.00", amountRemaining: "75.00", status: "active", note: "Reprinted order due to colour calibration issue", expiresAt: null, issuedAt: pastMonth });
  await db.insert(creditsTable).values({ customerId: customers[1].id, code: "MB-E5F6A7B8", amount: "50.00", amountRemaining: "25.00", status: "partially_redeemed", note: "Delay on rush order", expiresAt: null, issuedAt: twoMonthsAgo });
  await db.insert(creditsTable).values({ customerId: customers[2].id, code: "MB-C9D0E1F2", amount: "120.00", amountRemaining: "120.00", status: "active", note: "Quality complaint — banner printing", expiresAt: in10Days, issuedAt: twoMonthsAgo });
  await db.insert(creditsTable).values({ customerId: customers[3].id, code: "MB-G3H4I5J6", amount: "30.00", amountRemaining: "0.00", status: "redeemed", note: "Missing item from order", expiresAt: null, issuedAt: twoMonthsAgo });
  await db.insert(creditsTable).values({ customerId: customers[4].id, code: "MB-K7L8M9N0", amount: "200.00", amountRemaining: "200.00", status: "active", note: "Loyalty reward — 5th large order", expiresAt: in30Days, issuedAt: now });

  const credits = await db.select().from(creditsTable);
  console.log(`Inserted ${credits.length} credits`);

  const redeemTime1 = new Date(twoMonthsAgo); redeemTime1.setDate(twoMonthsAgo.getDate() + 14);
  const redeemTime2 = new Date(twoMonthsAgo); redeemTime2.setDate(twoMonthsAgo.getDate() + 5);

  const marcusCredit = credits.find(c => c.code === "MB-E5F6A7B8")!;
  const tomCredit = credits.find(c => c.code === "MB-G3H4I5J6")!;

  await db.insert(redemptionsTable).values({ creditId: marcusCredit.id, customerId: customers[1].id, amountApplied: "25.00", invoiceRef: "INV-2042", note: "Applied to business cards reorder", redeemedAt: redeemTime1 });
  await db.insert(redemptionsTable).values({ creditId: tomCredit.id, customerId: customers[3].id, amountApplied: "30.00", invoiceRef: "INV-2038", note: "Applied to poster order", redeemedAt: redeemTime2 });

  console.log("Inserted 2 redemptions");
  console.log("Seed complete.");
  await pool.end();
}

seed().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
