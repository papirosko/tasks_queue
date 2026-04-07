import { PostgreSqlContainer } from "@testcontainers/postgresql";
import fs from "fs";
import path from "path";

const stateFile = path.join(process.cwd(), "test", "integration", "global-setup.json");

export default async function globalSetup() {
  console.log("[integration:global-setup] starting postgres container");
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("testdb")
    .withUsername("test")
    .withPassword("test")
    .start();
  console.log("[integration:global-setup] postgres container started");

  console.log("[integration:global-setup] writing shared postgres state file");
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
  console.log("[integration:global-setup] shared postgres state file written");

  (global as any).__POSTGRES_CONTAINER__ = container;
  console.log("[integration:global-setup] setup completed");
}
