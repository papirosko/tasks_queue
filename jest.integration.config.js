export default {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^(.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/test/integration/**/*.test.ts"],
  globalSetup: "./test/integration/global-setup.ts",
  globalTeardown: "./test/integration/global-teardown.ts",
  collectCoverage: true,
  coverageDirectory: "coverage/integration",
  coverageReporters: ["text", "lcov"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/index.ts",
  ],
  testTimeout: 120000,
};
