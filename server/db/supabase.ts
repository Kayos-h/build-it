import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Server-only key: never expose this module or key to the browser bundle.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
export function check(error: { message: string; code?: string } | null): void {
  if (error) throw new Error(`Database operation failed: ${error.message}`);
}
