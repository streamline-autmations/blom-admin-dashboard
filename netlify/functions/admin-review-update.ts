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
  if (e.httpMethod !== "POST") return { statusCode: 405, headers: CORS };

  try {
    const { id, status, type } = JSON.parse(e.body || "{}");
    if (!id || !status) return { statusCode: 400, headers: CORS, body: "Missing id or status" };

    const updates: any = { status };
    if (status === 'approved') updates.published_at = new Date().toISOString();

    // Course reviews have no approve/reject webhooks.
    if (type === "course") {
      if (!["pending", "approved", "rejected"].includes(status)) {
        return { statusCode: 400, headers: CORS, body: "Invalid status" };
      }
      const { data, error } = await s.from("course_reviews").update(updates).eq("id", id).select("id");
      if (error) throw error;
      if (!data?.length) return { statusCode: 404, headers: CORS, body: "Review not found" };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    const { data, error } = await s.from("product_reviews").update(updates).eq("id", id).select().single();
    if (error) throw error;

    // Trigger webhook if configured
    if (status === 'approved' && process.env.REVIEWS_APPROVE_WEBHOOK) {
      console.log("Triggering approval webhook:", process.env.REVIEWS_APPROVE_WEBHOOK);
      await fetch(process.env.REVIEWS_APPROVE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(err => console.error("Webhook error:", err));
    } else if (status === 'rejected' && process.env.REVIEWS_REJECT_WEBHOOK) {
      console.log("Triggering rejection webhook:", process.env.REVIEWS_REJECT_WEBHOOK);
      await fetch(process.env.REVIEWS_REJECT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(err => console.error("Webhook error:", err));
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    return { statusCode: 500, headers: CORS, body: err.message || "Update failed" };
  }
};

export const handler = withAdminAuth(baseHandler);
