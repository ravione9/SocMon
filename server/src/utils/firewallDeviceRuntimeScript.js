/**
 * Painless: Forti / ECS hostname for one label per doc (same logic as SOC Reports).
 * Used by log search device filter + dropdown so they match the DEVICE column.
 */
export const FIREWALL_DEVICE_LABEL_SCRIPT = `
  String n = "";
  try { def d = doc["fgt.devname.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e0) {}
  if (n.length() == 0) { try { def d = doc["firewall_name.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e0b) {} }
  if (n.length() == 0) { try { def d = doc["fortinet.firewall.devname.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e1) {} }
  if (n.length() == 0) { try { def d = doc["fortinet.firewall.devname"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e2) {} }
  if (n.length() == 0) { try { def d = doc["device.name.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e3) {} }
  if (n.length() == 0) { try { def d = doc["observer.name.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e4) {} }
  if (n.length() == 0) { try { def d = doc["host.hostname.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e5) {} }
  if (n.length() == 0) { try { def d = doc["host.name.keyword"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e6) {} }
  if (n.length() == 0) { try { def d = doc["fgt.devname"]; if (d != null && d.size() != 0) { n = d.value; } } catch (Exception e7) {} }
  if (n.length() > 0) emit(n);
`.replace(/\s+/g, ' ')

/** Runtime field name shared by GET /logs/search filtering + aggs (firewall only). */
export const LOGSEARCH_FW_DEVICE_FIELD = 'logsearch_fw_device'

export function firewallLogsearchRuntimeMappings() {
  return {
    [LOGSEARCH_FW_DEVICE_FIELD]: {
      type: 'keyword',
      script: { source: FIREWALL_DEVICE_LABEL_SCRIPT },
    },
  }
}
