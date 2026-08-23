import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sequenceEnrollments = sqliteTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id").notNull(),
    personId: text("person_id").notNull(),
    status: text("status").notNull().default("active"), // active, completed, cancelled
    variables: text("variables").notNull().default("{}"), // JSON
    fromAddress: text("from_address").notNull(),
    enrolledAt: integer("enrolled_at").notNull(),
    cancelledAt: integer("cancelled_at"),
  },
  (table) => [
    index("enrollments_person_status_idx").on(table.personId, table.status),
    uniqueIndex("enrollments_one_active_person_idx")
      .on(table.personId)
      .where(sql`${table.status} = 'active'`),
    index("enrollments_sequence_status_idx").on(table.sequenceId, table.status),
  ],
);
