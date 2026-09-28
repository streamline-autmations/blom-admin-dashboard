import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { withAdminAuth } from "./_lib/with-admin-auth";
const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type"
};

const baseHandler: Handler = async (e) => {
  if (e.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS };

  try {
    const qp = e.queryStringParameters || {};
    const status = qp.status || "";
    const limit = Number(qp.limit || 50);
    const from = Number(qp.from || 0);
    const table = qp.type === "course" ? "course_reviews" : "product_reviews";
    let q = s.from(table).select("*").order("created_at", { ascending: false }).range(from, from+limit-1);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return { statusCode: 500, headers: CORS, body: error.message };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
  } catch (err:any) {
    return { statusCode: 500, headers: CORS, body: err.message || "admin-reviews failed" };
  }
};




export const handler = withAdminAuth(baseHandler);
