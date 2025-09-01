import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('Supabase URL:', supabaseUrl);
console.log('Service Key exists:', !!supabaseServiceKey);

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Supabase URL and Service Role Key must be provided in .env file'
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  // auth: {
  //   autoRefreshToken: false,
  //   persistSession: false,
  // },
});
