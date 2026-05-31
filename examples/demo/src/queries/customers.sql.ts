// A query with no index on `email` — sql_explain should report a Seq Scan.
export const findByEmail = `SELECT * FROM customers WHERE email = $1`
