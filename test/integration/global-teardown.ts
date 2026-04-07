import fs from "fs";
import path from "path";

const stateFile = path.join(process.cwd(), "test", "integration", "global-setup.json");

export default async function globalTeardown() {
  try {
    console.log("[integration:global-teardown] stopping postgres container");
    const container = (global as any).__POSTGRES_CONTAINER__;
    await container?.stop();
    console.log("[integration:global-teardown] postgres container stopped");
  } finally {
    if (fs.existsSync(stateFile)) {
      console.log("[integration:global-teardown] removing shared postgres state file");
      fs.unlinkSync(stateFile);
      console.log("[integration:global-teardown] shared postgres state file removed");
    }
    console.log("[integration:global-teardown] teardown completed");
  }
}
