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
  collectCoverage: false,
  testTimeout: 120000,
};
