import { db } from "../db"

export async function chargeCustomer(id: string): Promise<number> {
  try {
    const row = await db.query("SELECT balance FROM customers WHERE id = $1", [id]) // service-no-db violation
    return row.balance
  } catch (e) {
    throw new Error("charge failed") // no-try-catch violation
  }
}
