import { KodboxClient } from './packages/connectors/kodbox/src/kodbox-client.ts';
const client = new KodboxClient({
  baseUrl: 'http://localhost:8080',
  username: 'admin',
  password: 'admin123'
});
try {
  await client.login();
  const result = await client.list('/');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}