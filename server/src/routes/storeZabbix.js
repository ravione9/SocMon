import { createZabbixRouter } from './zabbix.js'
import { createZabbixClient } from '../services/zabbix.js'

export default createZabbixRouter(createZabbixClient('STORE_ZABBIX'))
