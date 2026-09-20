// The one file to edit after deploying the Edge Functions.
//
// Replace YOUR-PROJECT-REF with your Supabase project ref, which is the
// first part of the project URL in the Supabase dashboard.
//
// Nothing secret goes in here. It is served to every visitor. The function
// URL is public by design; what protects the door is that the function
// checks the pass server side.
window.DOOR_CONFIG = {
  openUrl: 'https://kszdyfugwyueqjpcydai.supabase.co/functions/v1/door-open',

  // Where passes.html sends its edits. Fill this in and whoever manages
  // passes only has to paste the manager key, not a URL as well.
  //
  // Public like everything else here, and harmless on its own: door-admin
  // refuses every request that does not carry DOOR_ADMIN_KEY, which is a
  // secret in Supabase and is never served to anyone.
  adminUrl: 'https://kszdyfugwyueqjpcydai.supabase.co/functions/v1/door-admin',

  // How long the success screen tells the visitor to push. The ESP32 polls
  // every 2 seconds, so the latch releases inside this window.
  releaseSeconds: 6,

  // What to tell someone when nothing works. Shown on the error screen.
  fallbackText: 'Use the intercom instead.',
};
