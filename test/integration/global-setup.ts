import { PostgreSqlContainer } from "@testcontainers/postgresql";
import fs from "fs";
import path from "path";

const stateFile = path.join(
  process.cwd(),
  "test",
  "integration",
  "global-setup.json",
);

export default async function globalSetup() {
  process.stdout.write(
    "[integration:global-setup] starting postgres container\n",
  );
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("testdb")
    .withUsername("test")
    .withPassword("test")
    .start();
  process.stdout.write(
    "[integration:global-setup] postgres container started\n",
  );

  process.stdout.write(
    "[integration:global-setup] writing shared postgres state file\n",
  );
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    }),
  );
  process.stdout.write(
    "[integration:global-setup] shared postgres state file written\n",
  );

  (global as any).__POSTGRES_CONTAINER__ = container;
  process.stdout.write("[integration:global-setup] setup completed\n");
}
