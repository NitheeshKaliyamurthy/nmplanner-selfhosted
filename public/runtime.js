/* global supabase */

(() => {
  const config = window.NMPLANNER_CONFIG || {};

  if (
    !window.supabase ||
    !config.supabaseUrl ||
    !config.supabasePublishableKey
  ) {
    return;
  }

  const client = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );

  window.NMPlannerRuntime = Object.freeze({ client });
})();
