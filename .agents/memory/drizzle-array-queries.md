---
name: Drizzle ORM array queries
description: How to correctly query with IN / ANY patterns in Drizzle ORM
---

# Drizzle ORM Array Queries

## Rule
Use `inArray(column, arrayValue)` from `drizzle-orm` for filtering rows by an array of IDs.

```ts
import { inArray } from "drizzle-orm";
const rows = await db.select().from(table).where(inArray(table.id, ids));
```

## What NOT to do
Do NOT use the `sql` template tag for `ANY()`:

```ts
// BROKEN — fails at runtime with "Failed query"
await db.select().from(table).where(
  sql`${table.id} = ANY(${ids}::int[])`
);
```

**Why:** Drizzle's `sql` template tag does not know how to serialize a plain JS array as a PostgreSQL array parameter. The query is built incorrectly and the driver throws at runtime.

**How to apply:** Any time you need to filter by an array of IDs, use `inArray()`. Handle the empty-array edge case explicitly (skip the query or return `[]`) since `inArray(col, [])` may generate invalid SQL.
