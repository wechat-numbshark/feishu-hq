import fs from 'fs';
const lines = fs.readFileSync('/tmp/kodbox_cookies.txt', 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
const cookies = {};
for (const line of lines) {
  const parts = line.split('\t');
  if (parts.length >= 7) cookies[parts[5]] = parts[6];
}
const csrfToken = cookies['CSRF_TOKEN'] || '';
const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
fetch(`http://localhost:8080/index.php?explorer/list&path=%2F&csrf=${csrfToken}`, {
  headers: {
    'X-CSRF-Token': csrfToken,
    'Cookie': cookieHeader
  }
}).then(r => r.text()).then(console.log);