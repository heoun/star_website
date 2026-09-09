// The architecture gate. Run in CI as:
//   npx depcruise backend --config backend/tools/arch-gate/dependency-cruiser.cjs
// A violating import is a build failure, not a review comment.
module.exports = {
  forbidden: [
    {
      name: "contracts-import-nothing",
      severity: "error",
      comment: "contracts/ may import only contracts/",
      from: { path: "^backend/contracts" },
      to: { pathNot: "^backend/contracts" },
    },
    {
      name: "core-imports-contracts-only",
      severity: "error",
      comment: "core/ may import contracts/ and core/ only",
      from: { path: "^backend/core" },
      to: { pathNot: "^backend/(contracts|core)" },
    },
    {
      name: "adapters-never-import-each-other",
      severity: "error",
      comment: "an adapter may import contracts/ and its own subtree only",
      from: { path: "^backend/adapters/([^/]+)/" },
      to: {
        path: "^backend/",
        pathNot: "^backend/(contracts|adapters/$1/)",
      },
    },
    {
      name: "only-app-is-the-composition-root",
      severity: "error",
      comment: "nothing outside app/ may import an adapter",
      from: { path: "^backend/", pathNot: "^backend/(app|adapters|tools)" },
      to: { path: "^backend/adapters" },
    },
    {
      name: "legacy-uses-the-mount-only",
      severity: "error",
      comment: "worker/ and site/ reach the backend through app/ only",
      from: { path: "^(worker|site)/" },
      to: { path: "^backend/", pathNot: "^backend/app" },
    },
    {
      name: "no-sneaky-dynamic-imports",
      severity: "error",
      from: { path: "^backend/" },
      to: { dependencyTypes: ["exotic-require"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    exclude: { path: "\\.(test|spec)\\.ts$" },
  },
};
