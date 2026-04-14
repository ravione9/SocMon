/**
 * Elasticsearch queries for SentinelOne / Sentinel XDR style documents in sentinel-*.
 * Field names vary by ingest (raw webhook, Elastic integration, ECS). We OR common shapes.
 */

export function getSentinelIndex() {
  return process.env.ES_SENTINEL_INDEX || 'sentinel-*'
}

/** Activity / audit lines without threatInfo.* (common in syslog-style ingest). */
const RESOLVED_THREAT_ACTIVITY_PHRASES = [
  'successfully killed the threat',
  'successfully quarantined the threat',
  'successfully quarantined',
  'quarantined the threat',
  'successfully removed the threat',
  'successfully removed',
  'successfully blocked the threat',
  'was successfully cleaned',
  'threat was successfully mitigated',
  'Successfully killed the threat',
  'Successfully quarantined the threat',
]

function resolvedThreatActivityMessageClauses() {
  const fields = ['message', 'event_message', 'event.original']
  const out = []
  for (const field of fields) {
    for (const phrase of RESOLVED_THREAT_ACTIVITY_PHRASES) {
      out.push({ match_phrase: { [field]: phrase } })
    }
  }
  return out
}

/** Threats still open / needing action (excludes kill/quarantine success audit lines → those match resolved). */
export const ACTIVE_THREAT_BOOL = {
  bool: {
    must: [
      {
        bool: {
          should: [
            { terms: { 'threatInfo.threatState.keyword': ['active', 'new', 'suspicious', 'not_mitigated', 'pending_unresolved'] } },
            { terms: { 'threatInfo.threatState': ['active', 'new', 'suspicious', 'not_mitigated'] } },
            { terms: { 'sentinel_one.threat.threat_state.keyword': ['active', 'new', 'suspicious'] } },
            { terms: { 'sentinel_one.threat.threat_state': ['active', 'new'] } },
            { terms: { 'threat_state.keyword': ['active', 'new', 'open'] } },
          ],
          minimum_should_match: 1,
        },
      },
    ],
    must_not: [
      {
        bool: {
          should: resolvedThreatActivityMessageClauses(),
          minimum_should_match: 1,
        },
      },
    ],
  },
}

/** Mitigated / closed / benign */
export const RESOLVED_THREAT_BOOL = {
  bool: {
    should: [
      {
        terms: {
          'threatInfo.threatState.keyword': [
            'mitigated',
            'resolved',
            'marked_as_benign',
            'benign',
            'kill_success',
            'quarantine_success',
            'deleted',
          ],
        },
      },
      {
        terms: {
          'threatInfo.threatState': ['mitigated', 'resolved', 'marked_as_benign', 'benign'],
        },
      },
      { terms: { 'sentinel_one.threat.threat_state.keyword': ['mitigated', 'resolved', 'benign', 'kill_success', 'quarantine_success'] } },
      { terms: { 'threat_state.keyword': ['mitigated', 'resolved', 'closed', 'benign', 'kill_success', 'quarantine_success'] } },
      ...resolvedThreatActivityMessageClauses(),
    ],
    minimum_should_match: 1,
  },
}

/** Message / event.original phrases for agent or endpoint device connectivity (indexed + text). */
const MSG_FIELDS = ['message', 'event.original']

function msgShouldClauses(phrases) {
  const out = []
  for (const field of MSG_FIELDS) {
    for (const p of phrases) {
      out.push({ match_phrase: { [field]: p } })
    }
  }
  return out
}

export const AGENT_DISCONNECTED_BOOL = {
  bool: {
    should: [
      { term: { 'agentRealtimeInfo.networkStatus.keyword': 'disconnected' } },
      { term: { 'agentRealtimeInfo.networkStatus': 'disconnected' } },
      { term: { 'sentinel_one.agent.network_status.keyword': 'disconnected' } },
      { terms: { 'event.action.keyword': ['agent_disconnected', 'disconnected', 'host-isolated', 'agent-offline'] } },
      { match_phrase: { message: 'Agent disconnected' } },
      { match_phrase: { message: 'disconnected from management' } },
      { match_phrase: { message: 'lost connection to management' } },
      ...msgShouldClauses([
        'Device disconnected',
        'device disconnected',
        'Endpoint disconnected',
        'endpoint disconnected',
        'Agent is offline',
        'agent is offline',
        'went offline',
        'no longer connected',
        'lost connection',
        'lost connectivity',
        'Disconnected from',
        'disconnected from management',
      ]),
    ],
    minimum_should_match: 1,
  },
}

export const AGENT_CONNECTED_BOOL = {
  bool: {
    should: [
      { term: { 'agentRealtimeInfo.networkStatus.keyword': 'connected' } },
      { term: { 'agentRealtimeInfo.networkStatus': 'connected' } },
      { term: { 'sentinel_one.agent.network_status.keyword': 'connected' } },
      { terms: { 'event.action.keyword': ['agent_connected', 'connected', 'agent-online', 'reconnected'] } },
      { match_phrase: { message: 'Agent connected' } },
      { match_phrase: { message: 'reconnected to management' } },
      ...msgShouldClauses([
        'Device connected',
        'device connected',
        'Endpoint connected',
        'endpoint connected',
        'connected to management',
        'Connected to management',
        'Connected to the management',
        'agent is online',
        'Agent is online',
        'Agent is now connected',
        'back online',
        'came online',
        'now connected',
        'successfully connected',
      ]),
    ],
    minimum_should_match: 1,
  },
}

export function hitsTotalValue(total) {
  if (total == null) return 0
  if (typeof total === 'object' && 'value' in total) return total.value
  if (typeof total === 'number') return total
  return 0
}

/**
 * USB peripheral attach/detach / device-control style events (exclude from “Active & detection” tab).
 * Wording varies by SentinelOne pipeline; we OR common phrases and actions.
 */
export const USB_PERIPHERAL_EVENT_BOOL = {
  bool: {
    should: [
      { match_phrase_prefix: { message: 'USB device' } },
      { match_phrase: { message: 'Removable device' } },
      { match_phrase: { message: 'Peripheral device' } },
      { match_phrase: { message: 'USB mass storage' } },
      { match_phrase: { message: 'USB storage' } },
      { match_phrase: { message: 'Device was connected' } },
      { match_phrase: { message: 'Device was disconnected' } },
      { match_phrase: { message: 'Device Control' } },
      { terms: { 'event.action.keyword': ['usb_device_control', 'device_control', 'usb.connected', 'usb.disconnected', 'peripheral_device'] } },
      { terms: { 'event.action': ['usb_device_control', 'device_control'] } },
      { terms: { 'event.category.keyword': ['device', 'peripheral'] } },
      { match_phrase: { 'event.original': 'USB' } },
    ],
    minimum_should_match: 1,
  },
}

/**
 * Extra filter: USB peripheral docs whose action/text indicates disconnect / removal.
 * Use in bool.must after USB_PERIPHERAL_EVENT_BOOL.
 */
export const USB_PERIPHERAL_DISCONNECT_FILTER = {
  bool: {
    should: [
      { wildcard: { 'event.action.keyword': '*disconnect*' } },
      { wildcard: { 'event.action': '*disconnect*' } },
      { terms: { 'event.action.keyword': ['usb.disconnected'] } },
      { match_phrase: { message: 'Device was disconnected' } },
      { match_phrase: { message: 'was disconnected' } },
      { match_phrase: { 'event.original': 'disconnect' } },
    ],
    minimum_should_match: 1,
  },
}

/** Bluetooth peripheral / radio connect / pairing style events (wording varies by pipeline). */
export const BLUETOOTH_DEVICE_EVENT_BOOL = {
  bool: {
    should: [
      { match_phrase: { message: 'Bluetooth device' } },
      { match_phrase: { message: 'bluetooth device' } },
      { match_phrase: { message: 'Bluetooth connection' } },
      { match_phrase: { message: 'Bluetooth radio' } },
      { match_phrase: { message: 'Bluetooth pairing' } },
      { match_phrase: { message: 'BT device' } },
      { match_phrase: { message: 'Bluetooth was' } },
      { match_phrase: { 'event.original': 'Bluetooth' } },
      { match_phrase: { message: 'Bluetooth' } },
      { match_phrase: { message: 'bluetooth' } },
      {
        terms: {
          'event.action.keyword': [
            'bluetooth_connected',
            'bluetooth.disconnected',
            'bluetooth.connected',
            'bt_device',
            'peripheral_bluetooth',
            'bluetooth_device_control',
          ],
        },
      },
      { terms: { 'event.category.keyword': ['bluetooth', 'bluetooth_device'] } },
    ],
    minimum_should_match: 1,
  },
}

/** “Blocked” slice for event-type donut: mitigated / quarantined / blocked actions. */
export const BLOCKED_OR_MITIGATED_BOOL = {
  bool: {
    should: [
      { terms: { 'threatInfo.threatState.keyword': ['mitigated', 'resolved', 'marked_as_benign', 'quarantine_success', 'kill_success'] } },
      { terms: { 'threatInfo.threatState': ['mitigated', 'resolved', 'marked_as_benign'] } },
      { terms: { 'sentinel_one.threat.threat_state.keyword': ['mitigated', 'resolved'] } },
      { terms: { 'event.action.keyword': ['blocked', 'threat_mitigated', 'quarantine', 'kill', 'remediate'] } },
      { match_phrase: { message: 'Threat mitigated' } },
      { match_phrase: { message: 'was blocked' } },
    ],
    minimum_should_match: 1,
  },
}

/**
 * @param {'all'|'no_usb'|'usb_only'|'bt_only'|'bluetooth_only'} scope
 * @returns {object} Elasticsearch clause for bool.must (use match_all for all)
 */
export function sentinelScopeClause(scope) {
  const s = String(scope || 'all').toLowerCase()
  if (s === 'no_usb') return { bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } }
  if (s === 'usb_only') return USB_PERIPHERAL_EVENT_BOOL
  if (s === 'bt_only' || s === 'bluetooth_only') return BLUETOOTH_DEVICE_EVENT_BOOL
  return { match_all: {} }
}
