import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('Supabase URL:', supabaseUrl);
console.log('서비스 키 존재 여부:', !!supabaseServiceKey);

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    '.env 파일에 Supabase URL 및 서비스 역할 키를 제공해야 합니다.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  // auth: {
  //   autoRefreshToken: false,
  //   persistSession: false,
  // },
});
