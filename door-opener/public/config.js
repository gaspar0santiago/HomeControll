// The one file to edit after deploying the Edge Functions.
//
// Replace YOUR-PROJECT-REF with your Supabase project ref, which is the
// first part of the project URL in the Supabase dashboard.
//
// Nothing secret goes in here. It is served to every visitor. The function
// URL is public by design; what protects the door is that the function
// checks the pass server side.
window.DOOR_CONFIG = {
  openUrl: 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/door-open',

  // How long the success screen tells the visitor to push. The ESP32 polls
  // every 2 seconds, so the latch releases inside this window.
  releaseSeconds: 6,

  // What to tell someone when nothing works. Shown on the error screen.
  fallbackText: 'Use the intercom instead.',
};
