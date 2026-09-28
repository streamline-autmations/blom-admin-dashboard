import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { withAdminAuth } from "./_lib/with-admin-auth";

const getSupabaseAdmin = () => {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });
};

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const baseHandler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    console.log('Delete review request:', body);

    if (!body.id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing required field: id' })
      };
    }

    const supabase = getSupabaseAdmin();
    const table = body.type === 'course' ? 'course_reviews' : 'product_reviews';

    // Verify the review exists and is rejected before deleting
    const { data: review, error: fetchError } = await supabase
      .from(table)
      .select('id, status')
      .eq('id', body.id)
      .single();

    if (fetchError || !review) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: 'Review not found' })
      };
    }

    if (review.status !== 'rejected') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Only rejected reviews can be deleted' })
      };
    }

    // Hard delete - permanently remove the review from the database
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', body.id)
      .eq('status', 'rejected');

    if (error) {
      console.error('Supabase error:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: error.message })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, deleted: true })
    };

  } catch (e: any) {
    console.error('Server error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};

export const handler = withAdminAuth(baseHandler);
