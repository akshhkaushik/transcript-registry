import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { rawDb } from "./runtime";

export function getDb() {
  return drizzle(rawDb(), { schema });
}
