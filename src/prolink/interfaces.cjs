const os = require('node:os');

function listInterfaces() {
  const interfaces = os.networkInterfaces();
  const rows = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      rows.push({
        id: `${name}:${entry.address}`,
        name,
        address: entry.address,
        netmask: entry.netmask,
        mac: entry.mac || '',
        cidr: entry.cidr || ''
      });
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

module.exports = {listInterfaces};
