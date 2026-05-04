/* Postgres (Compose) → migrations inside api image (fills node_modules volume) → API. Needs `docker compose up --wait` (Compose ~v2.29+). */
const { spawnSync } = require('child_process');

function run(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('docker compose up -d --wait postgres');
run(
  'docker compose run --rm api sh -c "npm ci && npm run migration:run"',
);
run('docker compose up --build api'); 
