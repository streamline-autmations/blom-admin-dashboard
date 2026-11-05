import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { withAdminAuth } from "./_lib/with-admin-auth";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const baseHandler: Handler = async (event) => {
  try {
    // Fetch from the CORRECT 'contacts' table.
    // PostgREST caps a single response at 1000 rows, so page through with
    // .range() until a page comes back short of a full page.
    const PAGE_SIZE = 1000;
    let all: any[] = [];
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      all = all.concat(data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(all)
    };
  } catch (e: any) {
    console.error("Fetch Contacts Error:", e);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: e.message || "Failed to fetch contacts" }) 
    };
  }
};

export const handler = withAdminAuth(baseHandler);
