import fs from "fs";
import path from "path";

const stateFile = path.join(
  process.cwd(),
  "test",
  "integration",
  "global-setup.json",
);

export default async function globalTeardown() {
  try {
    process.stdout.write(
      "[integration:global-teardown] stopping postgres container\n",
    );
    const container = (global as any).__POSTGRES_CONTAINER__;
    if (container !== undefined && container !== null) {
      await container.stop();
    }
    process.stdout.write(
      "[integration:global-teardown] postgres container stopped\n",
    );
  } finally {
    if (fs.existsSync(stateFile)) {
      process.stdout.write(
        "[integration:global-teardown] removing shared postgres state file",
      );
      fs.unlinkSync(stateFile);
      process.stdout.write(
        "[integration:global-teardown] shared postgres state file removed",
      );
    }
    process.stdout.write("[integration:global-teardown] teardown completed\n");
  }
}
