import InfraMonitoringPage from '../Infra/InfraMonitoringPage.jsx'

export default function StoreZabbixPage() {
  return (
    <InfraMonitoringPage
      apiBase="/api/store-zabbix"
      pageTitle="Store Zabbix"
      connectedLabel="Connected to Store Zabbix"
      urlEnvVar="STORE_ZABBIX_URL"
      tokenEnvVar="STORE_ZABBIX_API_TOKEN"
      loadingLabel="Loading store infrastructure data…"
    />
  )
}
