import StoreZabbixPage from '../StoreZabbix/StoreZabbixPage.jsx'

/** Store Zabbix dashboard scoped to the RP System Zabbix host group only. */
export default function RoDashboardPage() {
  return (
    <StoreZabbixPage
      pageTitle="Ro Dashboard"
      connectedLabel="RP System group · Store Zabbix"
      lockedHostGroup="RP System"
      lockedRopGroupKey="rp"
      customDashScope="ro-dashboard"
      dashboardVariant="ro"
    />
  )
}
