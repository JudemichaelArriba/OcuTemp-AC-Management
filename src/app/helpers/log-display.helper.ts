const SOURCE_LABELS: Readonly<Record<string, string>> = {
  NO_ASSIGNED_ROOM:   'No Room Assigned',
  no_assigned_room:   'No Room Assigned',
  NO_SCHEDULE_TODAY:  'No Schedule Today',
  no_schedule_today:  'No Schedule Today',
  MANUAL_OVERRIDE:    'Manual Override',
  manual:             'Manual Control',
  OUTSIDE_SCHEDULE:   'Outside Schedule Hours',
  outside_schedule:   'Outside Schedule Hours',
  SCHEDULE:           'Active Schedule',
  schedule:           'Active Schedule',
  ml:                 'AI / Machine Learning',
  network:            'Network',
  startup:            'System Startup',
  control:            'Control System',
  boot:               'Device Boot',
  empty:              'Room Unoccupied',
  override_cleared:   'Override Cleared',
};

const REASON_LABELS: Readonly<Record<string, string>> = {
  schedule_mode_changed:   'Schedule Mode Changed',
  auth_ready:              'Authentication Ready',
  startup_state_loaded:    'Startup State Loaded',
  applied:                 'State Applied',
  stream_json_on:          'Manual Power On',
  stream_json_off:         'Manual Power Off',
  stream_json_updated:     'Manual Update',
  render_call_failed:      'AI Prediction Failed',
  suggest_only:            'AI Suggestion (Pending)',
  auto_apply:              'AI Auto-Applied',
  startup_load:            'Startup Load',
  source_changed:          'Control Source Changed',
};

const EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  mode_change:       'Mode Change',
  ac_state_changed:  'AC State Changed',
  firebase_ready:    'System Ready',
  boot:              'Device Boot',
  manual_override:   'Manual Override',
  ml_failure:        'AI Prediction Failed',
  ml_suggestion:     'AI Suggestion',
  ml_auto_applied:   'AI Auto-Applied',
  ai_toggle_changed: 'AI Toggle Changed',
};

const MODE_LABELS: Readonly<Record<string, string>> = {
  NO_ASSIGNED_ROOM:  'No Room Assigned',
  NO_SCHEDULE_TODAY: 'No Schedule Today',
  MANUAL_OVERRIDE:   'Manual Override',
  OUTSIDE_SCHEDULE:  'Outside Schedule Hours',
  SCHEDULE:          'Active Schedule',
  boot:              'Booting',
};

function fallback(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function formatSource(raw: string): string {
  return SOURCE_LABELS[raw] ?? fallback(raw);
}

export function formatReason(raw: string): string {
  return REASON_LABELS[raw] ?? fallback(raw);
}

export function formatEventType(raw: string): string {
  return EVENT_TYPE_LABELS[raw] ?? fallback(raw);
}

export function formatMode(raw: string): string {
  return MODE_LABELS[raw] ?? fallback(raw);
}